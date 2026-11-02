#!/usr/bin/env python3
"""Reads replies in tracked threads, applies the automatic rules, and queues the rest for /replies.

Automatic (no judgment needed, applied the moment a reply is seen):
  bounce        -> company 'bounced', email + domain suppressed
  remove_me     -> company 'unsubscribed', suppressed. Never emailed again.
  no            -> company 'replied_no', suppressed ("no thanks", "not interested")
  out_of_office -> logged only; their follow-up still goes out
  gmail_warning -> a sending-limit or spam notice: sending is paused
Everything else -> company 'replied' (so no follow-up goes out) and waits for Claude to classify.

  python3 scripts/replies.py scan --since 2026-10-28
  python3 scripts/replies.py pending
  python3 scripts/replies.py classify MESSAGE_ID interested --summary "Wants a demo, free Thursday"
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from email.utils import parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import iso_now, now_ct, tz  # noqa: E402
import db  # noqa: E402
import gmail  # noqa: E402

CLASSES = ["interested", "question", "not_now", "no", "out_of_office", "bounce", "remove_me"]
CLASS_TO_STATUS = {
    "interested": "replied_interested",
    "question": "replied_question",
    "not_now": "not_now",
    "no": "replied_no",
    "remove_me": "unsubscribed",
    "bounce": "bounced",
}

REMOVE = re.compile(r"\b(remove me|remove us|unsubscribe|take me off|take us off|stop emailing|stop sending|"
                    r"do not (contact|email)|don'?t (contact|email)|no more emails)\b", re.I)
NO = re.compile(r"\b(no thanks|no thank you|not interested|we'?re (all )?set|we are (all )?set|we'?re good|"
                r"pass on this|not a (good )?fit|not something we need|don'?t need)\b", re.I)
OOO = re.compile(r"out of (the )?office|automatic reply|auto-?reply|autoreply|away from (the|my) (office|desk)|on vacation|on leave", re.I)
GMAIL_WARNING = re.compile(r"limit for sending|sending limit|rate limit|too many messages|quota|"
                           r"\bspam\b|unsolicited|bulk mail|reputation|blocklist|blacklist|spamhaus", re.I)
QUOTE_START = re.compile(r"^\s*(On .+wrote:|-----\s*Original Message|From:\s|Sent from my|________________)", re.I | re.M)


def new_text(body: str) -> str:
    """The reply itself, without the quoted thread below it."""
    m = QUOTE_START.search(body or "")
    text = body[:m.start()] if m else (body or "")
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(">")).strip()


def rule_class(m: dict) -> str:
    text = new_text(m.get("body") or "")
    if m.get("is_bounce"):
        return "gmail_warning" if GMAIL_WARNING.search(m.get("body") or "") else "bounce"
    if REMOVE.search(text):
        return "remove_me"
    if (m.get("auto_submitted") or "").lower().startswith("auto-") or OOO.search(m.get("subject") or "") or (
            OOO.search(text) and len(text) < 600):
        return "out_of_office"
    if NO.search(text):
        return "no"
    return "needs_review"


def pause(conn, reason: str) -> None:
    db.set_setting(conn, "paused", reason)
    db.log_event(conn, None, "paused", reason)
    conn.commit()


def apply_class(conn, company_id: str, cls: str, m: dict | None = None, summary: str = "") -> None:
    c = db.get_company(conn, company_id)
    received = (m or {}).get("date", iso_now())[:10]
    if cls in ("bounce", "gmail_warning") and (m or {}).get("is_bounce", cls == "bounce"):
        failed = ((m or {}).get("bounced_recipient") or "").lower()
        db.suppress(conn, email=failed or c["email"], reason="bounced", company_id=company_id, source="replies")
        db.suppress_company(conn, company_id, "bounced", "replies")
        conn.execute("UPDATE emails SET status = 'bounced' WHERE company_id = ? AND status = 'sent' AND lower(to_addr) = ?",
                     (company_id, failed or (c["email"] or "").lower()))
        db.update_company(conn, company_id, status="bounced", reply_class="bounce", reply_summary=summary or f"Bounced: {failed}")
    if cls == "gmail_warning":
        pause(conn, f"Gmail sent a limit/spam notice: {(m or {}).get('subject', '')}")
    elif cls == "bounce":
        pass
    elif cls == "out_of_office":
        db.log_event(conn, company_id, "out_of_office", summary or (m or {}).get("snippet", ""))
    elif cls in CLASS_TO_STATUS:
        fields = {"status": CLASS_TO_STATUS[cls], "reply_class": cls, "replied_at": c["replied_at"] or received}
        if summary:
            fields["reply_summary"] = summary
        db.update_company(conn, company_id, **fields)
        if cls == "remove_me":
            db.suppress_company(conn, company_id, "asked to be removed", "replies")
            if m:
                db.suppress(conn, email=parseaddr(m["from"])[1], reason="asked to be removed", company_id=company_id, source="replies")
        elif cls == "no":
            db.suppress_company(conn, company_id, "declined (no thanks)", "replies")
            if m:
                db.suppress(conn, email=parseaddr(m["from"])[1], reason="declined (no thanks)", company_id=company_id, source="replies")
    elif cls == "needs_review":
        if c["status"] in ("emailed", "followed_up"):
            db.update_company(conn, company_id, status="replied", reply_class="unclassified", replied_at=received)
    # A reply means the queued follow-up must not go out.
    if cls not in ("out_of_office", "gmail_warning"):
        conn.execute("UPDATE emails SET status = 'superseded', error = 'they replied' "
                     "WHERE company_id = ? AND kind = 'follow_up' AND status IN ('drafted', 'approved', 'queued')", (company_id,))
    db.log_event(conn, company_id, f"reply_{cls}", summary or (m or {}).get("snippet", "")[:200])


def scan(conn, since: dt.datetime) -> list[dict]:
    """Check Gmail, apply automatic rules to anything new. Returns the new messages with their rule class."""
    new = []
    for m in gmail.list_new_replies(conn, since):
        if conn.execute("SELECT 1 FROM inbound WHERE message_id = ?", (m["id"],)).fetchone():
            continue
        cls = rule_class(m)
        auto = cls != "needs_review"
        conn.execute(
            "INSERT INTO inbound (message_id, company_id, thread_id, received_at, from_addr, subject, snippet, rule_class, "
            "final_class, seen_at, handled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (m["id"], m["company_id"], m["thread_id"], m["date"], m["from"], m["subject"], (m["snippet"] or "")[:300],
             cls, cls if auto else None, iso_now(), iso_now() if auto else None))
        apply_class(conn, m["company_id"], cls, m)
        conn.commit()
        new.append({**m, "rule_class": cls})
    db.set_setting(conn, "last_reply_scan", iso_now())
    conn.commit()
    return new


def bounce_rate(conn, day: dt.date) -> tuple[int, int]:
    """(bounced, sent) for emails this system sent on `day`."""
    rows = conn.execute("SELECT status FROM emails WHERE kind IN ('first_touch', 'follow_up') AND substr(sent_at, 1, 10) = ?",
                        (day.isoformat(),)).fetchall()
    return sum(1 for r in rows if r["status"] == "bounced"), len(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scan"); p.add_argument("--since", help="YYYY-MM-DD; default = last scan or 3 days ago")
    sub.add_parser("pending")
    p = sub.add_parser("classify"); p.add_argument("message_id"); p.add_argument("cls", choices=CLASSES)
    p.add_argument("--summary", required=True); p.add_argument("--next-step"); p.add_argument("--due")
    a = ap.parse_args(argv)
    conn = db.connect()
    if a.cmd == "scan":
        if a.since:
            since = dt.datetime.combine(dt.date.fromisoformat(a.since), dt.time(0, 0), tz())
        else:
            last = db.get_setting(conn, "last_reply_scan")
            since = dt.datetime.fromisoformat(last) - dt.timedelta(hours=1) if last else now_ct() - dt.timedelta(days=3)
        new = scan(conn, since)
        for m in new:
            print(f"{m['rule_class']:14} {m['company_id']:32} {m['from'][:40]:40} {m['subject'][:50]}")
        print(f"{len(new)} new inbound message(s). Run `replies.py pending` for the ones that need a read.")
        if db.get_setting(conn, "paused"):
            print(f"SENDING PAUSED: {db.get_setting(conn, 'paused')}")
    elif a.cmd == "pending":
        rows = conn.execute("SELECT * FROM inbound WHERE final_class IS NULL ORDER BY received_at").fetchall()
        print(json.dumps([dict(r) for r in rows], indent=2))
    elif a.cmd == "classify":
        row = conn.execute("SELECT * FROM inbound WHERE message_id = ?", (a.message_id,)).fetchone()
        if not row:
            raise SystemExit(f"no inbound message {a.message_id}")
        m = {"id": row["message_id"], "from": row["from_addr"], "date": row["received_at"], "subject": row["subject"],
             "snippet": row["snippet"], "bounced_recipient": ""}
        apply_class(conn, row["company_id"], a.cls, m, a.summary)
        conn.execute("UPDATE inbound SET final_class = ?, summary = ?, handled_at = ? WHERE message_id = ?",
                     (a.cls, a.summary, iso_now(), a.message_id))
        if a.next_step:
            db.update_company(conn, row["company_id"], next_step=a.next_step, next_step_due=a.due)
        conn.commit()
        print(f"{row['company_id']}: {a.cls}")


if __name__ == "__main__":
    main()
