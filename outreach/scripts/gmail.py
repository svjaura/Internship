#!/usr/bin/env python3
"""Gmail + Calendar helper. Only ever acts on drafts and threads this system created or tracks.

Ownership rule: every draft id this system creates is stored in the `emails` table. Any call that
edits or sends a draft checks that table first and refuses if the id isn't there. There is no
delete or trash function in this file on purpose.

  python3 scripts/gmail.py auth                 # one-time browser login, saves secrets/token.json
  python3 scripts/gmail.py whoami               # which Gmail account the token belongs to
  python3 scripts/gmail.py replies --since 2026-10-28
  python3 scripts/gmail.py thread THREAD_ID
  python3 scripts/gmail.py send-draft EMAIL_ID  # only approved drafts; replies need explicit approval
  python3 scripts/gmail.py freebusy --days 7

Set OUTREACH_FAKE_GMAIL=1 to run against a local fake mailbox (data/fake_gmail.json) for tests.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import mimetypes
import os
import re
import sys
import uuid
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, ROOT, SECRETS, iso_now, load_config, load_sender, now_ct, tz  # noqa: E402
import db  # noqa: E402

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",   # read replies and threads
    "https://www.googleapis.com/auth/gmail.compose",    # create, update and send drafts
    "https://www.googleapis.com/auth/calendar.readonly",  # free/busy for proposing meeting times
]
CREDENTIALS = SECRETS / "credentials.json"
TOKEN = SECRETS / "token.json"


class GmailError(Exception):
    pass


class RateLimitError(GmailError):
    """Gmail said slow down (429 / quota / sending limit). The sender pauses on this."""


class AuthError(GmailError):
    pass


class NotOwnedError(GmailError):
    """Tried to act on a draft or thread this system didn't create."""


# ---------------------------------------------------------------- backends

class RealBackend:
    def __init__(self, interactive: bool = False):
        self.gmail, self.calendar = self._services(interactive)

    @staticmethod
    def _services(interactive: bool):
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
            from googleapiclient.discovery import build
        except ImportError as e:
            raise AuthError("Google libraries missing. Run: python3 -m pip install -r requirements.txt") from e
        creds = None
        if TOKEN.exists():
            creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as e:  # refresh token revoked or expired (Testing-mode apps expire weekly)
                if not interactive:
                    raise AuthError("Gmail login expired. Run: python3 scripts/gmail.py auth") from e
                creds = None
        if not creds or not creds.valid:
            if not interactive:
                raise AuthError("Not logged in to Gmail. Run: python3 scripts/gmail.py auth")
            if not CREDENTIALS.exists():
                raise AuthError(f"Missing {CREDENTIALS}. See SETUP.md step 2.")
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), SCOPES)
            creds = flow.run_local_server(port=0)
        SECRETS.mkdir(exist_ok=True)
        TOKEN.write_text(creds.to_json())
        os.chmod(TOKEN, 0o600)
        return (build("gmail", "v1", credentials=creds, cache_discovery=False),
                build("calendar", "v3", credentials=creds, cache_discovery=False))

    def _call(self, req):
        from googleapiclient.errors import HttpError
        try:
            return req.execute()
        except HttpError as e:
            status = getattr(e.resp, "status", 0)
            text = str(e)
            if status == 429 or re.search(r"rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|sending limit", text):
                raise RateLimitError(text) from e
            raise GmailError(text) from e

    def profile_email(self):
        return self._call(self.gmail.users().getProfile(userId="me"))["emailAddress"]

    def create_draft(self, raw, thread_id=None):
        msg = {"raw": raw}
        if thread_id:
            msg["threadId"] = thread_id
        d = self._call(self.gmail.users().drafts().create(userId="me", body={"message": msg}))
        return d["id"], d["message"]["id"], d["message"].get("threadId")

    def update_draft(self, draft_id, raw, thread_id=None):
        msg = {"raw": raw}
        if thread_id:
            msg["threadId"] = thread_id
        d = self._call(self.gmail.users().drafts().update(userId="me", id=draft_id, body={"message": msg}))
        return d["id"], d["message"]["id"], d["message"].get("threadId")

    def send_draft(self, draft_id):
        m = self._call(self.gmail.users().drafts().send(userId="me", body={"id": draft_id}))
        return m["id"], m.get("threadId"), m.get("labelIds", [])

    def list_message_ids(self, query):
        ids, token = [], None
        while True:
            r = self._call(self.gmail.users().messages().list(userId="me", q=query, maxResults=500, pageToken=token))
            ids += [(m["id"], m["threadId"]) for m in r.get("messages", [])]
            token = r.get("nextPageToken")
            if not token:
                return ids

    def get_message(self, message_id):
        return _parse_api_message(self._call(self.gmail.users().messages().get(userId="me", id=message_id, format="full")))

    def get_thread(self, thread_id):
        t = self._call(self.gmail.users().threads().get(userId="me", id=thread_id, format="full"))
        return [_parse_api_message(m) for m in t.get("messages", [])]

    def freebusy(self, start, end):
        body = {"timeMin": start.isoformat(), "timeMax": end.isoformat(), "items": [{"id": "primary"}]}
        r = self._call(self.calendar.freebusy().query(body=body))
        return [(b["start"], b["end"]) for b in r["calendars"]["primary"].get("busy", [])]


def _parse_api_message(m):
    headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}

    def walk(part):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", "replace")
        for p in part.get("parts", []) or []:
            t = walk(p)
            if t:
                return t
        return ""

    return {
        "id": m["id"], "thread_id": m.get("threadId"), "label_ids": m.get("labelIds", []),
        "from": headers.get("from", ""), "to": headers.get("to", ""), "subject": headers.get("subject", ""),
        "date": dt.datetime.fromtimestamp(int(m.get("internalDate", 0)) / 1000, tz()).isoformat(),
        "message_id_header": headers.get("message-id", ""), "references": headers.get("references", ""),
        "auto_submitted": headers.get("auto-submitted", ""), "failed_recipients": headers.get("x-failed-recipients", ""),
        "snippet": m.get("snippet", ""), "body": walk(m.get("payload", {})) or m.get("snippet", ""),
    }


class FakeBackend:
    """A tiny local mailbox so the whole send loop can be tested without touching real Gmail."""

    def __init__(self, path: Path | None = None):
        self.path = Path(os.environ.get("OUTREACH_FAKE_GMAIL_PATH", path or DATA / "fake_gmail.json"))
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"drafts": {}, "messages": {}, "busy": [], "fail_next_send": None}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.state, indent=1))

    def profile_email(self):
        return "fake@example.com"

    def _store_message(self, raw, thread_id, labels):
        from email import message_from_bytes
        mime = message_from_bytes(base64.urlsafe_b64decode(raw))
        mid = uuid.uuid4().hex[:16]
        body = ""
        for part in mime.walk():
            if part.get_content_type() == "text/plain":
                body = part.get_payload(decode=True).decode("utf-8", "replace")
                break
        self.state["messages"][mid] = {
            "id": mid, "thread_id": thread_id or mid, "label_ids": labels, "from": mime["From"], "to": mime["To"],
            "subject": mime["Subject"], "date": now_ct().isoformat(), "message_id_header": mime["Message-ID"] or f"<{mid}@fake>",
            "references": mime["References"] or "", "auto_submitted": "", "failed_recipients": "", "snippet": body[:80], "body": body,
            "attachments": [p.get_filename() for p in mime.walk() if p.get_filename()],
        }
        return mid, thread_id or mid

    def create_draft(self, raw, thread_id=None):
        mid, tid = self._store_message(raw, thread_id, ["DRAFT"])
        did = "r" + uuid.uuid4().hex[:12]
        self.state["drafts"][did] = mid
        self._save()
        return did, mid, tid

    def update_draft(self, draft_id, raw, thread_id=None):
        old = self.state["messages"][self.state["drafts"][draft_id]]
        mid, tid = self._store_message(raw, thread_id or old["thread_id"], ["DRAFT"])
        old["label_ids"] = ["REPLACED"]
        self.state["drafts"][draft_id] = mid
        self._save()
        return draft_id, mid, tid

    def send_draft(self, draft_id):
        fail = self.state.get("fail_next_send")
        if fail:
            self.state["fail_next_send"] = None
            self._save()
            raise RateLimitError(fail) if "limit" in fail else GmailError(fail)
        mid = self.state["drafts"].pop(draft_id)
        msg = self.state["messages"][mid]
        msg["label_ids"] = ["SENT"]
        msg["date"] = now_ct().isoformat()
        self._save()
        return mid, msg["thread_id"], ["SENT"]

    def add_inbound(self, thread_id, from_addr, body, subject="Re:", failed_recipient="", auto_submitted=""):
        mid = uuid.uuid4().hex[:16]
        self.state["messages"][mid] = {
            "id": mid, "thread_id": thread_id or mid, "label_ids": ["INBOX"], "from": from_addr, "to": "fake@example.com",
            "subject": subject, "date": now_ct().isoformat(), "message_id_header": f"<{mid}@fake>", "references": "",
            "auto_submitted": auto_submitted, "failed_recipients": failed_recipient, "snippet": body[:80], "body": body,
        }
        self._save()
        return mid

    def list_message_ids(self, query):
        after = re.search(r"after:(\d+)", query)
        since = dt.datetime.fromtimestamp(int(after.group(1)), tz()) if after else None
        out = []
        for m in self.state["messages"].values():
            if "INBOX" not in m["label_ids"]:
                continue
            if since and dt.datetime.fromisoformat(m["date"]) < since:
                continue
            if "mailer-daemon" in query and not re.search(r"mailer-daemon|postmaster", m["from"], re.I):
                continue
            froms = re.findall(r"from:([\w.+'-]+@[\w.-]+)", query)
            if froms and parseaddr(m["from"])[1].lower() not in froms:
                continue
            out.append((m["id"], m["thread_id"]))
        return out

    def get_message(self, message_id):
        return self.state["messages"][message_id]

    def get_thread(self, thread_id):
        msgs = [m for m in self.state["messages"].values() if m["thread_id"] == thread_id and m["label_ids"] != ["REPLACED"]]
        return sorted(msgs, key=lambda m: m["date"])

    def freebusy(self, start, end):
        return [tuple(b) for b in self.state.get("busy", [])]


_backend = None


def backend(interactive: bool = False):
    global _backend
    if _backend is None:
        _backend = FakeBackend() if os.environ.get("OUTREACH_FAKE_GMAIL") == "1" else RealBackend(interactive)
    return _backend


# ---------------------------------------------------------------- message building

def build_raw(to: str, subject: str, body: str, attach_resume: bool, in_reply_to: str = "", references: str = "",
              attachments: list[str] | None = None) -> str:
    sender = load_sender()
    msg = EmailMessage()
    msg["From"] = formataddr((sender["name"], sender["email"]))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=sender["email"].split("@")[1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = (references + " " + in_reply_to).strip()
    msg.set_content(body)
    if attach_resume:
        pdf = ROOT / load_config()["resume_path"]
        if not pdf.exists():
            raise GmailError(f"Resume not found at {pdf}. Put resume.pdf in the outreach folder.")
        msg.add_attachment(pdf.read_bytes(), maintype="application", subtype="pdf",
                           filename=sender.get("resume_attachment_name", "Resume.pdf"))
    total = 0
    for a in attachments or []:
        path = Path(a)
        if not path.is_file():
            raise GmailError(f"attachment not found: {path}")
        data = path.read_bytes()
        total += len(data)
        if total > 20_000_000:
            raise GmailError("attachments add up to more than 20 MB; Gmail will reject it")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=path.name)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


# ---------------------------------------------------------------- ownership

def owned_email(conn, email_id: int):
    row = conn.execute("SELECT * FROM emails WHERE id = ?", (email_id,)).fetchone()
    if row is None or not row["gmail_draft_id"]:
        raise NotOwnedError(f"email {email_id} isn't a draft this system created")
    return row


def tracked_threads(conn) -> dict[str, str]:
    """thread id -> company id, for every thread this system created or was told about."""
    out = {}
    for r in conn.execute("SELECT id, legacy_thread_id, gmail_thread_id FROM companies"):
        for t in (r["legacy_thread_id"], r["gmail_thread_id"]):
            if t:
                out[t] = r["id"]
    for r in conn.execute("SELECT company_id, gmail_thread_id FROM emails WHERE gmail_thread_id IS NOT NULL"):
        out[r["gmail_thread_id"]] = r["company_id"]
    for r in conn.execute("SELECT thread_id, company_id FROM threads"):
        out.setdefault(r["thread_id"], r["company_id"])
    return out


ACTIVE_STATUSES = ("replied", "replied_question", "replied_interested", "not_now", "meeting_pending", "meeting_booked", "call", "proposal")


def active_contacts(conn) -> dict[str, str]:
    """email -> company id for people Sai is in conversation with. A new thread they start still counts as a reply."""
    out = {}
    q = f"SELECT id, email, alt_emails FROM companies WHERE status IN ({','.join('?' * len(ACTIVE_STATUSES))})"
    for r in conn.execute(q, ACTIVE_STATUSES):
        for e in db.split_emails(r["email"]) + db.split_emails(r["alt_emails"]):
            out[e] = r["id"]
    q = f"SELECT ct.email, ct.company_id FROM contacts ct JOIN companies c ON c.id = ct.company_id WHERE ct.email IS NOT NULL AND c.status IN ({','.join('?' * len(ACTIVE_STATUSES))})"
    for r in conn.execute(q, ACTIVE_STATUSES):
        out.setdefault(r["email"].lower(), r["company_id"])
    return out


def assert_tracked_thread(conn, thread_id: str) -> str:
    cid = tracked_threads(conn).get(thread_id)
    if not cid:
        raise NotOwnedError(f"thread {thread_id} isn't tracked by this system")
    return cid


# ---------------------------------------------------------------- operations

def create_draft(conn, company_id: str, kind: str, to: str, subject: str, body: str, *, attach_resume: bool,
                 thread_id: str | None = None, in_reply_to: str = "", references: str = "",
                 status: str = "drafted", scheduled_for: str | None = None, voice_warnings: str = "",
                 attachments: list[str] | None = None) -> int:
    files = [str(Path(a).resolve()) for a in attachments or []]
    raw = build_raw(to, subject, body, attach_resume, in_reply_to, references, files)
    draft_id, message_id, tid = backend().create_draft(raw, thread_id)
    cur = conn.execute(
        "INSERT INTO emails (company_id, kind, to_addr, subject, body, gmail_draft_id, gmail_message_id, gmail_thread_id, "
        "status, scheduled_for, voice_warnings, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (company_id, kind, to, subject, body, draft_id, message_id, tid, status, scheduled_for, voice_warnings,
         json.dumps(files) if files else None, iso_now()))
    db.log_event(conn, company_id, f"draft_{kind}", f"draft {draft_id} to {to}: {subject}")
    conn.commit()
    return cur.lastrowid


def update_draft(conn, email_id: int, subject: str, body: str) -> None:
    row = owned_email(conn, email_id)
    if row["status"] not in ("drafted", "approved", "queued"):
        raise GmailError(f"email {email_id} is {row['status']}, can't edit it")
    files = json.loads(row["attachments"]) if row["attachments"] else []
    raw = build_raw(row["to_addr"], subject, body, attach_resume=row["kind"] == "first_touch", attachments=files)
    _, message_id, tid = backend().update_draft(row["gmail_draft_id"], raw, row["gmail_thread_id"] if row["kind"] != "first_touch" else None)
    conn.execute("UPDATE emails SET subject = ?, body = ?, gmail_message_id = ?, gmail_thread_id = ? WHERE id = ?",
                 (subject, body, message_id, tid, email_id))
    db.log_event(conn, row["company_id"], "draft_edited", f"email {email_id}")
    conn.commit()


def send_draft(conn, email_id: int) -> tuple[str, str]:
    row = owned_email(conn, email_id)
    if row["status"] == "sent":
        raise GmailError(f"email {email_id} was already sent")
    if row["kind"] in ("first_touch", "reply") and not row["approved_at"]:
        raise GmailError(f"email {email_id} ({row['kind']}) has no approval recorded. Nothing is sent without Sai's OK.")
    blockers = db.send_blockers(conn, row["company_id"], row["to_addr"], row["kind"])
    if blockers:
        conn.execute("UPDATE emails SET status = 'failed', error = ? WHERE id = ?", ("; ".join(blockers), email_id))
        conn.commit()
        raise GmailError(f"blocked: {'; '.join(blockers)}")
    conn.execute("UPDATE emails SET status = 'sending' WHERE id = ?", (email_id,))
    conn.commit()
    try:
        message_id, thread_id, _ = backend().send_draft(row["gmail_draft_id"])
    except Exception as e:
        conn.execute("UPDATE emails SET status = ?, error = ? WHERE id = ?", ("failed" if not isinstance(e, RateLimitError) else row["status"], str(e)[:500], email_id))
        conn.commit()
        raise
    now = iso_now()
    conn.execute("UPDATE emails SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ?, error = NULL WHERE id = ?",
                 (now, message_id, thread_id, email_id))
    cid = row["company_id"]
    if row["kind"] == "first_touch":
        db.update_company(conn, cid, status="emailed", sent_at=now[:10], gmail_thread_id=thread_id)
        db.suppress_company(conn, cid, "already contacted", "sent")
    elif row["kind"] == "follow_up":
        db.update_company(conn, cid, status="followed_up", followed_up_at=now[:10])
    db.log_event(conn, cid, f"sent_{row['kind']}", f"message {message_id} to {row['to_addr']}")
    conn.commit()
    return message_id, thread_id


def reply_in_thread(conn, company_id: str, thread_id: str, body: str, to: str | None = None, subject: str | None = None,
                    attachments: list[str] | None = None) -> int:
    """Creates a reply DRAFT in a tracked thread. Never sends; Sai approves in chat, then send_draft."""
    owner = assert_tracked_thread(conn, thread_id)
    if owner != company_id:
        raise NotOwnedError(f"thread {thread_id} belongs to {owner}, not {company_id}")
    msgs = backend().get_thread(thread_id)
    if not msgs:
        raise GmailError(f"thread {thread_id} is empty")
    last = msgs[-1]
    me = load_sender()["email"].lower()
    if not to:
        inbound = [m for m in msgs if me.replace(".", "") not in parseaddr(m["from"])[1].lower().replace(".", "")]
        to = parseaddr((inbound[-1] if inbound else last)["from"])[1]
    subj = subject or last["subject"] or ""
    if not subj.lower().startswith("re:"):
        subj = "Re: " + subj
    blockers = db.send_blockers(conn, company_id, to, "reply")
    if blockers:
        raise GmailError(f"blocked: {'; '.join(blockers)}")
    return create_draft(conn, company_id, "reply", to, subj, body, attach_resume=False, thread_id=thread_id,
                        in_reply_to=last["message_id_header"], references=last.get("references", ""), attachments=attachments)


def get_thread(conn, thread_id: str) -> list[dict]:
    assert_tracked_thread(conn, thread_id)
    return backend().get_thread(thread_id)


BOUNCE_FROM = re.compile(r"mailer-daemon|postmaster|mail delivery (subsystem|system)", re.I)


def list_new_replies(conn, since: dt.datetime) -> list[dict]:
    """Inbound messages in tracked threads since `since`, plus bounce notices. Read-only."""
    threads = tracked_threads(conn)
    me = load_sender()["email"].lower().replace(".", "")
    epoch = int(since.timestamp())
    candidates = {}
    for mid, tid in backend().list_message_ids(f"after:{epoch} -in:sent -in:drafts"):
        if tid in threads:  # untracked mail is never opened
            candidates[mid] = tid
    # Bounce notices sometimes land outside the original thread.
    for mid, tid in backend().list_message_ids(f"after:{epoch} {{from:mailer-daemon from:postmaster}}"):
        candidates[mid] = tid
    # People in an active conversation sometimes start a fresh thread (e.g. "here are my tables").
    contacts = active_contacts(conn)
    addrs = sorted(contacts)
    for i in range(0, len(addrs), 20):
        group = " ".join(f"from:{a}" for a in addrs[i:i + 20])
        for mid, tid in backend().list_message_ids(f"after:{epoch} -in:sent {{{group}}}"):
            if tid not in threads:
                m = backend().get_message(mid)
                cid = contacts.get(parseaddr(m["from"])[1].lower())
                if cid:
                    db.track_thread(conn, tid, cid, "they_started")
                    threads[tid] = cid
            candidates[mid] = tid
    out, seen = [], set()
    for mid, tid in candidates.items():
        m = backend().get_message(mid)
        sender = parseaddr(m["from"])[1].lower()
        if sender.replace(".", "") == me:
            continue
        is_bounce = bool(BOUNCE_FROM.search(m["from"])) or bool(m.get("failed_recipients"))
        if tid not in threads and not is_bounce:
            continue
        company = threads.get(tid)
        failed = m.get("failed_recipients") or ""
        if is_bounce and not failed:
            hit = re.search(r"(?:delivered to|deliver(?:ed)? to|recipient|address)\s*:?\s*<?([\w.+'-]+@[\w.-]+\.\w+)", m["body"], re.I)
            failed = hit.group(1) if hit else ""
        if is_bounce and not company and failed:
            row = conn.execute("SELECT company_id FROM emails WHERE lower(to_addr) = ? ORDER BY id DESC LIMIT 1", (failed.lower(),)).fetchone()
            company = row["company_id"] if row else None
        if not company or mid in seen:
            continue
        seen.add(mid)
        out.append({**{k: m.get(k) for k in ("id", "thread_id", "from", "subject", "date", "snippet", "body", "auto_submitted")},
                    "company_id": company, "is_bounce": is_bounce, "bounced_recipient": failed})
    return sorted(out, key=lambda r: r["date"])


def freebusy(start: dt.datetime, end: dt.datetime) -> list[tuple[str, str]]:
    return backend().freebusy(start, end)


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("auth")
    sub.add_parser("whoami")
    p = sub.add_parser("replies"); p.add_argument("--since", required=True, help="YYYY-MM-DD (Central)")
    p = sub.add_parser("thread"); p.add_argument("thread_id")
    p = sub.add_parser("send-draft"); p.add_argument("email_id", type=int)
    p = sub.add_parser("freebusy"); p.add_argument("--days", type=int, default=7)
    a = ap.parse_args(argv)
    conn = db.connect()
    if a.cmd == "auth":
        email = RealBackend(interactive=True).profile_email()
        print(f"Authorized as {email}. Token saved to secrets/token.json (not printed, not committed).")
        expected = load_sender()["email"].lower().replace(".", "")
        if email.lower().replace(".", "") != expected:
            print(f"WARNING: sender.local.json says {load_sender()['email']}. Re-run auth with the right account.")
    elif a.cmd == "whoami":
        print(backend().profile_email())
    elif a.cmd == "replies":
        since = dt.datetime.combine(dt.date.fromisoformat(a.since), dt.time(0, 0), tz())
        print(json.dumps(list_new_replies(conn, since), indent=2))
    elif a.cmd == "thread":
        for m in get_thread(conn, a.thread_id):
            print(f"--- {m['date']}  {m['from']}\nSubject: {m['subject']}\n\n{m['body'].strip()}\n")
    elif a.cmd == "send-draft":
        mid, tid = send_draft(conn, a.email_id)
        print(f"sent email {a.email_id}: message {mid} in thread {tid}")
    elif a.cmd == "freebusy":
        start = now_ct()
        print(json.dumps(freebusy(start, start + dt.timedelta(days=a.days)), indent=2))


if __name__ == "__main__":
    try:
        main()
    except GmailError as e:
        raise SystemExit(f"gmail: {e}")
