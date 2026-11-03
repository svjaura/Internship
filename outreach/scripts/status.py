#!/usr/bin/env python3
"""Terminal dashboard for /status."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONTACTED, POSITIVE, REPLIED, ROOT, load_config, now_ct  # noqa: E402
import db  # noqa: E402

ORDER = ["todo", "verified", "drafted", "approved", "queued", "emailed", "followed_up", "replied", "replied_question",
         "replied_interested", "not_now", "replied_no", "unsubscribed", "bounced", "pass", "meeting_pending",
         "meeting_booked", "call", "proposal", "won", "lost", "dropped", "cut", "archived"]
ACTIVE = ("replied", "replied_question", "replied_interested", "meeting_pending", "meeting_booked", "call", "proposal")


def pct(a: int, b: int) -> str:
    return f"{a / b:.1%}" if b else "n/a"


def dashboard(conn) -> str:
    now = now_ct()
    today = now.date()
    week_start = today - dt.timedelta(days=today.weekday())
    cfg = load_config()
    out = [f"OUTREACH STATUS  {now:%a %b %-d, %Y %-I:%M %p} CT", ""]

    paused = db.get_setting(conn, "paused")
    sender = ROOT / "sender.local.json"
    import json
    postal = json.loads(sender.read_text()).get("postal_address") if sender.exists() else None
    token = (ROOT / "secrets" / "token.json").exists()
    out.append(f"Sending: {'PAUSED (' + paused + ')' if paused else 'ready'}   Gmail login: {'yes' if token else 'not set up'}   "
               f"Postal address: {'set' if postal else 'MISSING (needed before any cold email)'}")
    stuck = conn.execute("SELECT COUNT(*) FROM emails WHERE status = 'sending'").fetchone()[0]
    if stuck:
        out.append(f"!! {stuck} email(s) stuck in 'sending'. Check Gmail Sent before running anything else.")
    out.append("")

    counts = dict(conn.execute("SELECT status, COUNT(*) FROM companies GROUP BY status").fetchall())
    total = sum(counts.values())
    out.append(f"Companies by status ({total} total)")
    line = []
    for s in ORDER + sorted(set(counts) - set(ORDER)):
        if counts.get(s):
            line.append(f"{s} {counts[s]}")
    for i in range(0, len(line), 5):
        out.append("  " + "   ".join(line[i:i + 5]))
    out.append("")

    sent_week = conn.execute("SELECT kind, COUNT(*) FROM emails WHERE kind IN ('first_touch', 'follow_up') AND status IN ('sent', 'bounced') "
                             "AND substr(sent_at, 1, 10) >= ? GROUP BY kind", (week_start.isoformat(),)).fetchall()
    sw = dict(sent_week)
    queued = conn.execute("SELECT COUNT(*) FROM emails WHERE status = 'queued'").fetchone()[0]
    out.append(f"This week (since Mon {week_start:%b %-d}): sent {sw.get('first_touch', 0)} first-touch + {sw.get('follow_up', 0)} follow-ups. "
               f"Queued: {queued}. Daily cap {cfg['daily_cap']}.")

    cold = conn.execute(f"SELECT status FROM companies WHERE source IN ('legacy_csv', 'prospect') "
                        f"AND status IN ({','.join('?' * len(CONTACTED))})", tuple(CONTACTED)).fetchall()
    contacted = len(cold)
    replied = sum(1 for r in cold if r["status"] in REPLIED)
    positive = sum(1 for r in cold if r["status"] in POSITIVE)
    out.append(f"Reply rate (cold outreach): {replied}/{contacted} replied ({pct(replied, contacted)}), "
               f"{positive} positive ({pct(positive, contacted)})")
    camp = conn.execute(f"SELECT status FROM companies WHERE source = 'prospect' OR wave LIKE 'campaign%' AND status IN ({','.join('?' * len(CONTACTED))})",
                        tuple(CONTACTED)).fetchall()
    if camp:
        c_rep = sum(1 for r in camp if r["status"] in REPLIED)
        out.append(f"  this campaign: {c_rep}/{len(camp)} replied ({pct(c_rep, len(camp))})")
    meetings = conn.execute("SELECT company, status, meeting_at FROM companies WHERE status IN ('meeting_pending', 'meeting_booked') "
                            "ORDER BY meeting_at").fetchall()
    out.append(f"Meetings: {sum(1 for m in meetings if m['status'] == 'meeting_booked')} booked, "
               f"{sum(1 for m in meetings if m['status'] == 'meeting_pending')} times proposed"
               + (f" (new first-touch pauses above {cfg['max_pending_meetings']})" if meetings else ""))
    for m in meetings:
        out.append(f"  {m['company']}: {m['status']} {m['meeting_at'] or ''}")
    out.append("")

    rows = conn.execute(f"SELECT id, company, status, next_step, next_step_due FROM companies "
                        f"WHERE status IN ({','.join('?' * len(ACTIVE))}) ORDER BY "
                        f"CASE status WHEN 'proposal' THEN 0 WHEN 'call' THEN 1 WHEN 'meeting_booked' THEN 2 ELSE 3 END, "
                        f"next_step_due IS NULL, next_step_due", ACTIVE).fetchall()
    out.append(f"Open conversations and next steps ({len(rows)})")
    for r in rows:
        due = f" [due {r['next_step_due']}]" if r["next_step_due"] else ""
        nxt = (r["next_step"] or "no next step recorded").replace("\n", " ")
        out.append(f"  {r['company'][:28]:28} {r['status']:18} {nxt[:90]}{due}")
    out.append("")

    overdue = conn.execute("SELECT company, next_step_due, next_step FROM companies WHERE next_step_due < ? "
                           "AND status NOT IN ('archived', 'dropped', 'cut', 'won', 'lost') ORDER BY next_step_due",
                           (today.isoformat(),)).fetchall()
    quiet_cut = (today - dt.timedelta(days=14)).isoformat()
    quiet = []
    for r in rows:
        last = conn.execute("SELECT MAX(ts) FROM events WHERE company_id = ? AND type NOT IN ('imported', 'active_deal', 'suppressed', 'status')",
                            (r["id"],)).fetchone()[0]
        c = db.get_company(conn, r["id"])
        last_date = max(filter(None, [last and last[:10], c["replied_at"], c["followed_up_at"], c["sent_at"]]), default=None)
        if last_date and last_date < quiet_cut and not r["next_step_due"]:
            quiet.append((r["company"], last_date))
    waiting = conn.execute("SELECT c.company FROM emails e JOIN companies c ON c.id = e.company_id WHERE e.kind = 'reply' AND e.status = 'drafted'").fetchall()
    unread = conn.execute("SELECT COUNT(*) FROM inbound WHERE final_class IS NULL").fetchone()[0]
    out.append("Overdue / needs you")
    if not (overdue or quiet or waiting or unread):
        out.append("  nothing")
    for r in overdue:
        out.append(f"  OVERDUE {r['next_step_due']}  {r['company']}: {(r['next_step'] or '')[:80]}")
    for name, d in quiet:
        out.append(f"  quiet since {d}: {name}")
    for r in waiting:
        out.append(f"  reply draft waiting for your OK: {r['company']}")
    if unread:
        out.append(f"  {unread} reply/replies not classified yet: run /replies")
    return "\n".join(out)


if __name__ == "__main__":
    print(dashboard(db.connect()))
