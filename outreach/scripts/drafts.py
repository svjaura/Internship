#!/usr/bin/env python3
"""Create, edit, approve and cut drafts. Every write goes through voicecheck and the suppression check.

  python3 scripts/drafts.py create batch.json        # first-touch drafts (resume attached) for verified companies
  python3 scripts/drafts.py edit EMAIL_ID --subject "..." --body-file body.txt
  python3 scripts/drafts.py approve EMAIL_ID [EMAIL_ID ...]
  python3 scripts/drafts.py cut EMAIL_ID --reason "..."
  python3 scripts/drafts.py pending                  # drafts waiting for review
  python3 scripts/drafts.py reply COMPANY_ID --thread THREAD_ID --body-file reply.txt   # reply DRAFT, never sent
  python3 scripts/drafts.py send-reply EMAIL_ID --approval "Sai: 'send it' (chat, Nov 3)"

batch.json is a list of:
  {"id": "oak-street-roofing", "greeting_name": "Dana", "short_name": "Oak Street Roofing",
   "workflow_short": "quote drafts", "subject": "Quote drafts for Oak Street Roofing",
   "body": "Hi Dana,\\n\\n...one clear ask?"}
`body` is greeting through the ask. The sign-off, signature, postal address and opt-out are added here.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import iso_now  # noqa: E402
import db  # noqa: E402
import gmail  # noqa: E402
import voicecheck  # noqa: E402


def core_body(full: str) -> str:
    """The editable part of a stored email (everything above the sign-off)."""
    return full.split("\n\nThanks,\n", 1)[0].strip()


def create_first_touch(conn, item: dict) -> tuple[int | None, list[str], list[str]]:
    cid = item["id"]
    c = db.get_company(conn, cid)
    if c is None:
        return None, [f"no company {cid}"], []
    if c["status"] not in ("verified", "drafted"):
        return None, [f"{cid} is {c['status']}; only verified companies get a first-touch draft"], []
    existing = conn.execute("SELECT id FROM emails WHERE company_id = ? AND kind = 'first_touch' AND status IN ('drafted', 'approved', 'queued')",
                            (cid,)).fetchone()
    profile = {k: item[k] for k in ("greeting_name", "short_name", "workflow_short") if item.get(k)}
    if profile:
        db.update_company(conn, cid, **profile)
        c = db.get_company(conn, cid)
    to = item.get("to") or c["email"]
    blockers = db.send_blockers(conn, cid, to, "first_touch")
    if blockers:
        return None, blockers, []
    subject = item.get("subject") or f"{(c['workflow_short'] or '').capitalize()} for {voicecheck.short_name(dict(c))}"
    errors, warnings = voicecheck.check("first_touch", subject, item["body"], dict(c))
    if errors:
        return None, errors, warnings
    full = voicecheck.compose_full(item["body"], "first_touch")
    if existing:  # re-drafting replaces the content of our own draft instead of piling up a second one
        gmail.update_draft(conn, existing["id"], subject, full)
        conn.execute("UPDATE emails SET voice_warnings = ? WHERE id = ?", ("\n".join(warnings), existing["id"]))
        conn.commit()
        return existing["id"], [], warnings
    eid = gmail.create_draft(conn, cid, "first_touch", to, subject, full, attach_resume=True, voice_warnings="\n".join(warnings))
    db.update_company(conn, cid, status="drafted", drafted_at=iso_now())
    conn.commit()
    return eid, [], warnings


def edit(conn, email_id: int, subject: str | None, body: str | None) -> tuple[list[str], list[str]]:
    row = gmail.owned_email(conn, email_id)
    c = db.get_company(conn, row["company_id"])
    subject = subject if subject is not None else row["subject"]
    body = body if body is not None else core_body(row["body"])
    errors, warnings = voicecheck.check(row["kind"], subject, body, dict(c))
    if row["kind"] == "reply":
        errors = [e for e in errors if "postal address" not in e]
    if errors:
        return errors, warnings
    gmail.update_draft(conn, email_id, subject, voicecheck.compose_full(body, row["kind"]))
    conn.execute("UPDATE emails SET voice_warnings = ? WHERE id = ?", ("\n".join(warnings), email_id))
    conn.commit()
    return [], warnings


def approve(conn, email_id: int) -> None:
    row = gmail.owned_email(conn, email_id)
    if row["kind"] != "first_touch":
        raise SystemExit(f"email {email_id} is a {row['kind']}; replies are approved with send-reply, follow-ups need no approval")
    if row["status"] != "drafted":
        raise SystemExit(f"email {email_id} is {row['status']}")
    conn.execute("UPDATE emails SET status = 'approved', approved_at = ? WHERE id = ?", (iso_now(), email_id))
    db.update_company(conn, row["company_id"], status="approved", approved_at=iso_now())
    db.log_event(conn, row["company_id"], "approved", f"email {email_id}")
    conn.commit()


def cut(conn, email_id: int, reason: str) -> None:
    row = gmail.owned_email(conn, email_id)
    if row["status"] in ("sent", "sending"):
        raise SystemExit(f"email {email_id} is already {row['status']}")
    # Our own draft stays in Gmail (nothing is deleted) but is renamed so it can't be sent by accident.
    if not (row["subject"] or "").startswith("[CUT"):
        gmail.update_draft(conn, email_id, f"[CUT, do not send] {row['subject']}", row["body"])
    conn.execute("UPDATE emails SET status = 'cut', error = ? WHERE id = ?", (reason, email_id))
    if row["kind"] == "first_touch":
        db.update_company(conn, row["company_id"], status="cut")
    db.append_note(conn, row["company_id"], f"Draft {email_id} cut: {reason}")
    conn.commit()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create"); p.add_argument("json")
    p = sub.add_parser("edit"); p.add_argument("email_id", type=int); p.add_argument("--subject"); p.add_argument("--body-file")
    p = sub.add_parser("approve"); p.add_argument("email_ids", type=int, nargs="+")
    p = sub.add_parser("cut"); p.add_argument("email_id", type=int); p.add_argument("--reason", required=True)
    sub.add_parser("pending")
    p = sub.add_parser("reply"); p.add_argument("company_id"); p.add_argument("--thread", required=True); p.add_argument("--body-file", required=True)
    p.add_argument("--to")
    p.add_argument("--attach", action="append", default=[], help="file to attach; repeat for more")
    p = sub.add_parser("send-reply"); p.add_argument("email_id", type=int)
    p.add_argument("--approval", required=True, help="Sai's words in chat approving this exact reply")
    a = ap.parse_args(argv)
    conn = db.connect()

    if a.cmd == "create":
        items = json.loads(Path(a.json).read_text())
        ok = 0
        for item in items:
            eid, errors, warnings = create_first_touch(conn, item)
            if errors:
                print(f"SKIPPED {item.get('id')}: " + " | ".join(errors))
            else:
                ok += 1
                print(f"drafted {item['id']} (email {eid})" + (f"  warnings: {' | '.join(warnings)}" if warnings else ""))
        print(f"{ok}/{len(items)} drafted with the resume attached. Run /review next.")
    elif a.cmd == "edit":
        errors, warnings = edit(conn, a.email_id, a.subject, Path(a.body_file).read_text() if a.body_file else None)
        print("\n".join(f"ERROR {e}" for e in errors) or "updated" + (f" (warnings: {' | '.join(warnings)})" if warnings else ""))
    elif a.cmd == "approve":
        for eid in a.email_ids:
            approve(conn, eid)
        print(f"approved {len(a.email_ids)}")
    elif a.cmd == "cut":
        cut(conn, a.email_id, a.reason)
        print(f"cut {a.email_id} (Gmail draft kept, renamed [CUT, do not send])")
    elif a.cmd == "pending":
        rows = conn.execute("SELECT e.id, e.kind, c.company, e.to_addr, e.subject, e.voice_warnings FROM emails e "
                            "JOIN companies c ON c.id = e.company_id WHERE e.status = 'drafted' ORDER BY e.kind, e.id").fetchall()
        for r in rows:
            print(f"{r['id']:5} {r['kind']:12} {r['company'][:30]:30} {r['to_addr'][:32]:32} {r['subject']}")
        print(f"{len(rows)} draft(s) pending")
    elif a.cmd == "reply":
        body = Path(a.body_file).read_text()
        c = db.get_company(conn, a.company_id)
        errors, warnings = voicecheck.check("reply", "", body, dict(c))
        if errors:
            raise SystemExit("ERROR " + " | ".join(errors))
        eid = gmail.reply_in_thread(conn, a.company_id, a.thread, voicecheck.compose_full(body, "reply"), to=a.to,
                                    attachments=a.attach)
        row = conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        files = ", ".join(Path(f).name for f in json.loads(row["attachments"] or "[]"))
        print(f"Reply DRAFT {eid} saved in Gmail (not sent). To: {row['to_addr']}  Subject: {row['subject']}"
              + (f"  Attached: {files}" if files else "") + f"\n\n{row['body']}")
        if warnings:
            print("warnings: " + " | ".join(warnings))
    elif a.cmd == "send-reply":
        row = gmail.owned_email(conn, a.email_id)
        if row["kind"] != "reply":
            raise SystemExit("send-reply is only for replies")
        conn.execute("UPDATE emails SET status = 'approved', approved_at = ? WHERE id = ?", (iso_now(), a.email_id))
        db.log_event(conn, row["company_id"], "reply_approved", a.approval)
        conn.commit()
        mid, tid = gmail.send_draft(conn, a.email_id)
        print(f"sent reply {a.email_id} to {row['to_addr']}")


if __name__ == "__main__":
    try:
        main()
    except gmail.GmailError as e:
        raise SystemExit(f"gmail: {e}")
