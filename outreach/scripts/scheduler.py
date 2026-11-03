#!/usr/bin/env python3
"""Daily sending: queue approved drafts, queue the one follow-up, and run the 7:45 AM send window.

  python3 scripts/scheduler.py plan                 # approved first-touch drafts -> send days (25/day minus follow-ups)
  python3 scripts/scheduler.py followups [--dry-run] [--include-legacy]
  python3 scripts/scheduler.py run [--dry-run]      # what launchd runs at 7:45 AM CT on weekdays
  python3 scripts/scheduler.py report               # the 5-line morning report
  python3 scripts/scheduler.py state | pause --reason "..." | resume
  python3 scripts/scheduler.py install-launchd      # macOS only

Rules enforced here (see CLAUDE.md): max 25 per weekday including follow-ups, 7:45 to 9:30 AM Central only,
2 to 5 minutes apart at random, follow-ups first, stop on >3% bounces or any Gmail limit/spam signal,
no new first-touch while more than 5 meetings are pending, two failures in a row -> stop.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import plistlib
import random
import re
import subprocess
import sys
import time
from email.utils import parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    REPORTS, ROOT, STATE, add_business_days, business_days_between, is_business_day, iso_now, load_config,
    load_sender, next_send_day, now_ct, parse_hhmm, today_ct,
)
import db  # noqa: E402
import gmail  # noqa: E402
import replies  # noqa: E402
import voicecheck  # noqa: E402

FOLLOWUP_TEMPLATE = ROOT / "templates" / "follow_up.txt"
LABEL = "com.outreach.send"


# ---------------------------------------------------------------- helpers

def notify(message: str, title: str = "Outreach") -> None:
    """macOS notification + alerts log. Never raises."""
    REPORTS.mkdir(exist_ok=True)
    with open(REPORTS / "alerts.log", "a") as f:
        f.write(f"{iso_now()}  {message}\n")
    if sys.platform == "darwin" and not os.environ.get("OUTREACH_FAKE_GMAIL"):
        safe = message.replace('"', "'")[:200]
        subprocess.run(["osascript", "-e", f'display notification "{safe}" with title "{title}"'], check=False)


def log(message: str) -> None:
    REPORTS.mkdir(exist_ok=True)
    line = f"{iso_now()}  {message}"
    print(line, flush=True)
    with open(REPORTS / "send.log", "a") as f:
        f.write(line + "\n")


def pending_meetings(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM companies WHERE status IN ('meeting_pending', 'meeting_booked')").fetchone()[0]


def sent_on(conn, day: dt.date) -> int:
    return conn.execute("SELECT COUNT(*) FROM emails WHERE kind IN ('first_touch', 'follow_up') "
                        "AND status IN ('sent', 'bounced') AND substr(sent_at, 1, 10) = ?", (day.isoformat(),)).fetchone()[0]


def bounce_check(conn, day: dt.date) -> str | None:
    """Pause reason if the day's bounce rate is over the limit and there's a bounce Sai hasn't already resumed past."""
    bounced, sent = replies.bounce_rate(conn, day)
    threshold = load_config()["bounce_pause_threshold"]
    acked = int(db.get_setting(conn, f"bounce_ack_{day}") or 0)
    if sent and bounced / sent > threshold and bounced > acked:
        return f"{bounced} bounce(s) out of {sent} sent on {day} ({bounced / sent:.0%}, limit {threshold:.0%})"
    return None


def pause(conn, reason: str) -> None:
    replies.pause(conn, reason)
    notify(f"Sending paused: {reason}")
    log(f"PAUSED: {reason}")


# ---------------------------------------------------------------- plan

def plan(conn, start: dt.date | None = None) -> dict[str, int]:
    """Give every approved first-touch draft a send day. Follow-ups due that day eat into the 25."""
    cfg = load_config()
    cap = cfg["daily_cap"]
    now = now_ct()
    day = start or now.date()
    if day == now.date() and now.time() >= parse_hhmm(cfg["send_window"]["start"]):
        day += dt.timedelta(days=1)
    day = next_send_day(day)
    # Follow-ups that will come due: 8 business days after each sent or already-planned first touch.
    load: dict[dt.date, int] = {}
    for r in conn.execute("SELECT e.sent_at, e.scheduled_for FROM emails e JOIN companies c ON c.id = e.company_id "
                          "WHERE e.kind = 'first_touch' AND (e.status = 'queued' OR (e.status = 'sent' AND c.status = 'emailed'))"):
        base = dt.date.fromisoformat((r["sent_at"] or r["scheduled_for"])[:10])
        due = next_send_day(add_business_days(base, cfg["followup_business_days"]))
        load[due] = load.get(due, 0) + 1
    for r in conn.execute("SELECT scheduled_for FROM emails WHERE status = 'queued' AND scheduled_for IS NOT NULL"):
        d = dt.date.fromisoformat(r["scheduled_for"])
        load[d] = load.get(d, 0) + 1
    approved = conn.execute(
        "SELECT e.id, e.company_id, c.fit, c.bucket FROM emails e JOIN companies c ON c.id = e.company_id "
        "WHERE e.kind = 'first_touch' AND e.status = 'approved' ORDER BY CASE c.fit WHEN 'High' THEN 0 ELSE 1 END, e.id").fetchall()
    # Interleave buckets so every day is a mix, which keeps the read on what works honest.
    by_bucket: dict[str, list] = {}
    for r in approved:
        by_bucket.setdefault(r["bucket"] or "other", []).append(r)
    ordered = []
    while any(by_bucket.values()):
        for b in sorted(by_bucket):
            if by_bucket[b]:
                ordered.append(by_bucket[b].pop(0))
    out: dict[str, int] = {}
    for r in ordered:
        while load.get(day, 0) >= cap:
            day = next_send_day(day + dt.timedelta(days=1))
        conn.execute("UPDATE emails SET status = 'queued', scheduled_for = ? WHERE id = ?", (day.isoformat(), r["id"]))
        db.update_company(conn, r["company_id"], status="queued")
        load[day] = load.get(day, 0) + 1
        out[day.isoformat()] = out.get(day.isoformat(), 0) + 1
        # its own follow-up lands 8 business days later
        due = next_send_day(add_business_days(day, cfg["followup_business_days"]))
        load[due] = load.get(due, 0) + 1
    conn.commit()
    return out


# ---------------------------------------------------------------- follow-ups

def followup_text(company) -> str:
    template = FOLLOWUP_TEMPLATE.read_text().strip()
    return template.format(name=company["greeting_name"] or (company["contact_name"] or "").split(" ")[0] or "there",
                           short_company=voicecheck.short_name(dict(company)),
                           workflow=company["workflow_short"] or "the workflow I mentioned")


def due_followups(conn, today: dt.date, include_legacy: bool = False) -> list:
    n = load_config()["followup_business_days"]
    rows = conn.execute("SELECT * FROM companies WHERE status = 'emailed' AND sent_at IS NOT NULL").fetchall()
    out = []
    for c in rows:
        thread = c["gmail_thread_id"] or (c["legacy_thread_id"] if include_legacy else None)
        if not thread:
            continue
        if business_days_between(dt.date.fromisoformat(c["sent_at"][:10]), today) < n:
            continue
        exists = conn.execute("SELECT 1 FROM emails WHERE company_id = ? AND kind = 'follow_up' AND status != 'cut'", (c["id"],)).fetchone()
        if not exists:
            out.append((c, thread))
    return out


def queue_followups(conn, today: dt.date, dry_run: bool = False, include_legacy: bool = False) -> list[str]:
    me = load_sender()["email"].lower().replace(".", "")
    queued = []
    for c, thread in due_followups(conn, today, include_legacy):
        msgs = gmail.backend().get_thread(thread)
        if any(parseaddr(m["from"])[1].lower().replace(".", "") != me for m in msgs):
            db.update_company(conn, c["id"], status="replied", reply_class="unclassified")
            db.append_note(conn, c["id"], "Follow-up skipped: there's a reply in the thread. Run /replies.")
            continue
        first = [m for m in msgs if parseaddr(m["from"])[1].lower().replace(".", "") == me]
        if not first:
            continue
        to = c["email"]
        blockers = db.send_blockers(conn, c["id"], to, "follow_up")
        if blockers:
            log(f"follow-up for {c['id']} blocked: {'; '.join(blockers)}")
            continue
        body = followup_text(c)
        errors, _ = voicecheck.check("follow_up", "", body, dict(c))
        if errors:
            log(f"follow-up for {c['id']} failed the voice check: {errors}")
            continue
        if dry_run:
            queued.append(c["id"])
            continue
        subject = first[0]["subject"] or ""
        subject = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        gmail.create_draft(conn, c["id"], "follow_up", to, subject, voicecheck.compose_full(body, "follow_up"),
                           attach_resume=False, thread_id=thread, in_reply_to=first[-1]["message_id_header"],
                           references=first[-1].get("references", ""), status="queued", scheduled_for=today.isoformat())
        queued.append(c["id"])
    return queued


# ---------------------------------------------------------------- the send window

def acquire_lock() -> bool:
    STATE.mkdir(exist_ok=True)
    lock = STATE / "send.lock"
    if lock.exists():
        try:
            pid = int(lock.read_text().strip())
            os.kill(pid, 0)
            return False
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    lock.write_text(str(os.getpid()))
    return True


def release_lock() -> None:
    (STATE / "send.lock").unlink(missing_ok=True)


def run(conn, dry_run: bool = False, sleep=time.sleep, now_fn=now_ct) -> dict:
    cfg = load_config()
    start, end = parse_hhmm(cfg["send_window"]["start"]), parse_hhmm(cfg["send_window"]["end"])
    now = now_fn()
    today = now.date()
    result = {"sent_first": 0, "sent_followup": 0, "skipped": [], "stopped": None}
    if not is_business_day(today):
        log(f"{today} isn't a send day (weekend or holiday).")
        return result
    if now.time() >= end:
        log(f"It's {now:%H:%M}, past the {cfg['send_window']['end']} cutoff. Nothing sent; the queue rolls to the next send day.")
        return result
    if now.time() < start:
        wait = (dt.datetime.combine(today, start, now.tzinfo) - now).total_seconds()
        log(f"Waiting {wait / 60:.0f} min for the {cfg['send_window']['start']} window.")
        sleep(max(0, wait))
    if not acquire_lock():
        log("Another send run is already going. Exiting.")
        return result
    try:
        return _run_locked(conn, cfg, today, end, dry_run, sleep, now_fn, result)
    finally:
        release_lock()


def _run_locked(conn, cfg, today, end, dry_run, sleep, now_fn, result):
    paused = db.get_setting(conn, "paused")
    if paused:
        notify(f"Sending is paused: {paused}. Run `scheduler.py resume` after you check it.")
        result["stopped"] = f"paused: {paused}"
        return result
    try:
        last = db.get_setting(conn, "last_reply_scan")
        since = dt.datetime.fromisoformat(last) - dt.timedelta(hours=1) if last else now_fn() - dt.timedelta(days=3)
        replies.scan(conn, since)
    except gmail.AuthError as e:
        notify(str(e))
        result["stopped"] = str(e)
        return result
    for day in (today - dt.timedelta(days=1), today):
        reason = bounce_check(conn, day)
        if reason:
            pause(conn, reason)
            result["stopped"] = reason
            return result
    if db.get_setting(conn, "paused"):
        result["stopped"] = db.get_setting(conn, "paused")
        notify(f"Sending paused: {result['stopped']}")
        return result

    queue_followups(conn, today, dry_run=dry_run)
    remaining = cfg["daily_cap"] - sent_on(conn, today)
    followups = conn.execute("SELECT * FROM emails WHERE kind = 'follow_up' AND status = 'queued' AND scheduled_for <= ? "
                             "ORDER BY scheduled_for, id", (today.isoformat(),)).fetchall()
    first = conn.execute("SELECT e.* FROM emails e JOIN companies c ON c.id = e.company_id WHERE e.kind = 'first_touch' "
                         "AND e.status = 'queued' AND e.scheduled_for <= ? ORDER BY e.scheduled_for, e.id", (today.isoformat(),)).fetchall()
    meetings = pending_meetings(conn)
    if meetings > cfg["max_pending_meetings"] and first:
        notify(f"{meetings} meetings pending (max {cfg['max_pending_meetings']}). New first-touch sends are paused; follow-ups still go.")
        result["skipped"].append(f"first-touch paused: {meetings} meetings pending")
        first = []
    batch = (list(followups) + list(first))[:max(0, remaining)]
    log(f"Send window open: {len(followups)} follow-up(s) and {len(first)} first-touch queued, cap leaves room for {max(0, remaining)}.")

    failures = 0
    gap = cfg["gap_minutes"]
    for i, e in enumerate(batch):
        now = now_fn()
        if now.time() >= end:
            log(f"Hit the {cfg['send_window']['end']} cutoff. {len(batch) - i} roll to the next send day.")
            break
        if db.get_setting(conn, "paused"):
            result["stopped"] = db.get_setting(conn, "paused")
            break
        if e["kind"] == "follow_up":
            me = load_sender()["email"].lower().replace(".", "")
            if any(parseaddr(m["from"])[1].lower().replace(".", "") != me for m in gmail.backend().get_thread(e["gmail_thread_id"])):
                conn.execute("UPDATE emails SET status = 'superseded', error = 'they replied' WHERE id = ?", (e["id"],))
                db.update_company(conn, e["company_id"], status="replied", reply_class="unclassified")
                conn.commit()
                result["skipped"].append(f"{e['company_id']}: replied before the follow-up")
                continue
        if dry_run:
            log(f"[dry run] would send {e['kind']} to {e['to_addr']} ({e['company_id']}): {e['subject']}")
        else:
            try:
                gmail.send_draft(conn, e["id"])
                failures = 0
                result["sent_first" if e["kind"] == "first_touch" else "sent_followup"] += 1
                log(f"sent {e['kind']} to {e['to_addr']} ({e['company_id']})")
            except gmail.RateLimitError as err:
                pause(conn, f"Gmail rate limit: {str(err)[:150]}")
                result["stopped"] = "rate limit"
                break
            except (gmail.AuthError,) as err:
                notify(str(err))
                result["stopped"] = str(err)
                break
            except gmail.GmailError as err:
                failures += 1
                log(f"FAILED {e['company_id']}: {err}")
                result["skipped"].append(f"{e['company_id']}: {err}")
                if failures >= 2:
                    pause(conn, f"two sends failed in a row, last: {str(err)[:150]}")
                    result["stopped"] = "two failures"
                    break
                continue
            # Catch bounces from earlier sends while the window is still open.
            replies.scan(conn, dt.datetime.combine(today, dt.time(0, 0), now.tzinfo))
            reason = bounce_check(conn, today)
            if reason:
                pause(conn, reason)
                result["stopped"] = reason
                break
        if i < len(batch) - 1:
            left = (dt.datetime.combine(today, end, now.tzinfo) - now_fn()).total_seconds()
            pace = left / max(1, len(batch) - i - 1)
            wait = min(random.uniform(gap["min"] * 60, gap["max"] * 60), max(gap["min"] * 60, pace))
            sleep(wait)
    if not dry_run and (result["sent_first"] or result["sent_followup"]) and not result["stopped"]:
        sleep(240)  # give fast bounces a few minutes to arrive, then check once more
        replies.scan(conn, dt.datetime.combine(today, dt.time(0, 0), now_fn().tzinfo))
        reason = bounce_check(conn, today)
        if reason:
            pause(conn, reason)
            result["stopped"] = reason
    REPORTS.mkdir(exist_ok=True)
    report_text = report(conn, today)
    (REPORTS / f"{today}.md").write_text(report_text + "\n")
    notify(report_text.splitlines()[0])
    log(f"Done: {json.dumps(result)}")
    return result


# ---------------------------------------------------------------- report

def report(conn, day: dt.date | None = None) -> str:
    day = day or today_ct()
    since = (day - dt.timedelta(days=1)).isoformat()
    first = conn.execute("SELECT COUNT(*) FROM emails WHERE kind = 'first_touch' AND substr(sent_at, 1, 10) = ?", (day.isoformat(),)).fetchone()[0]
    fu = conn.execute("SELECT COUNT(*) FROM emails WHERE kind = 'follow_up' AND substr(sent_at, 1, 10) = ?", (day.isoformat(),)).fetchone()[0]
    left = conn.execute("SELECT COUNT(*) FROM emails WHERE status = 'queued'").fetchone()[0]
    inbound = conn.execute("SELECT rule_class, final_class, company_id FROM inbound WHERE substr(seen_at, 1, 10) >= ?", (since,)).fetchall()
    cls = [r["final_class"] or r["rule_class"] for r in inbound]
    interested = conn.execute("SELECT company FROM companies WHERE status = 'replied_interested'").fetchall()
    meetings = conn.execute("SELECT company, status, meeting_at FROM companies WHERE status IN ('meeting_pending', 'meeting_booked')").fetchall()
    needs = []
    if db.get_setting(conn, "paused"):
        needs.append(f"sending PAUSED ({db.get_setting(conn, 'paused')})")
    unread = sum(1 for c in cls if c == "needs_review")
    if unread:
        needs.append(f"{unread} repl{'y' if unread == 1 else 'ies'} to read (/replies)")
    waiting = conn.execute("SELECT COUNT(*) FROM emails WHERE kind = 'reply' AND status = 'drafted'").fetchone()[0]
    if waiting:
        needs.append(f"{waiting} reply draft(s) waiting for your OK")
    overdue = conn.execute("SELECT company FROM companies WHERE next_step_due IS NOT NULL AND next_step_due < ? "
                           "AND status NOT IN ('archived', 'dropped', 'cut', 'won', 'lost')", (day.isoformat(),)).fetchall()
    if overdue:
        needs.append("overdue: " + ", ".join(r["company"] for r in overdue[:4]))
    stuck = conn.execute("SELECT COUNT(*) FROM emails WHERE status = 'sending'").fetchone()[0]
    if stuck:
        needs.append(f"{stuck} email(s) stuck in 'sending', check Gmail Sent before anything else")
    return "\n".join([
        f"Sent {day:%a %b %-d}: {first} first-touch + {fu} follow-up ({first + fu}/{load_config()['daily_cap']}). {left} still queued.",
        f"Replies since yesterday: {len(cls)} ({cls.count('needs_review')} to read, {cls.count('bounce')} bounce, "
        f"{cls.count('out_of_office')} out of office, {cls.count('remove_me') + cls.count('no')} no/remove).",
        f"Interested: {len(interested)}" + (f" ({', '.join(r['company'] for r in interested[:5])})" if interested else ""),
        f"Meetings: {len(meetings)}" + (f" ({', '.join(r['company'] + (' ' + r['meeting_at'] if r['meeting_at'] else '') for r in meetings[:5])})" if meetings else ""),
        "Needs you: " + ("; ".join(needs) if needs else "nothing"),
    ])


# ---------------------------------------------------------------- launchd

def install_launchd() -> Path:
    if sys.platform != "darwin":
        raise SystemExit("launchd is macOS only. Run this on your Mac.")
    cfg = load_config()
    h, m = cfg["send_window"]["start"].split(":")
    python = sys.executable
    plist = {
        "Label": LABEL,
        "ProgramArguments": [python, str(ROOT / "scripts" / "scheduler.py"), "run"],
        "WorkingDirectory": str(ROOT),
        # launchd uses the Mac's clock; the script itself re-checks Central time and the window.
        "StartCalendarInterval": [{"Weekday": d, "Hour": int(h), "Minute": int(m)} for d in range(1, 6)],
        "StandardOutPath": str(REPORTS / "launchd.out.log"),
        "StandardErrorPath": str(REPORTS / "launchd.err.log"),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"},
    }
    dest = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    dest.parent.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(exist_ok=True)
    with open(dest, "wb") as f:
        plistlib.dump(plist, f)
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], check=False, capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(dest)], check=True)
    return dest


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("--start", help="YYYY-MM-DD")
    p = sub.add_parser("followups"); p.add_argument("--dry-run", action="store_true"); p.add_argument("--include-legacy", action="store_true")
    p = sub.add_parser("run"); p.add_argument("--dry-run", action="store_true")
    sub.add_parser("report")
    sub.add_parser("state")
    p = sub.add_parser("pause"); p.add_argument("--reason", required=True)
    sub.add_parser("resume")
    sub.add_parser("install-launchd")
    a = ap.parse_args(argv)
    conn = db.connect()
    if a.cmd == "plan":
        out = plan(conn, dt.date.fromisoformat(a.start) if a.start else None)
        for d, n in sorted(out.items()):
            print(f"{d}  {n} first-touch")
        print(f"{sum(out.values())} queued. Follow-ups are added on top on their due days, inside the same cap.")
    elif a.cmd == "followups":
        ids = queue_followups(conn, today_ct(), dry_run=a.dry_run, include_legacy=a.include_legacy)
        conn.commit()
        print(("Would queue" if a.dry_run else "Queued") + f" {len(ids)} follow-up(s): {', '.join(ids) or 'none due'}")
    elif a.cmd == "run":
        run(conn, dry_run=a.dry_run)
    elif a.cmd == "report":
        print(report(conn))
    elif a.cmd == "state":
        print(f"paused: {db.get_setting(conn, 'paused') or 'no'}")
        print(f"sent today: {sent_on(conn, today_ct())}/{load_config()['daily_cap']}")
        print(f"queued: {conn.execute('SELECT COUNT(*) FROM emails WHERE status = ?', ('queued',)).fetchone()[0]}")
        print(f"meetings pending: {pending_meetings(conn)} (first-touch pauses above {load_config()['max_pending_meetings']})")
        print(f"last reply scan: {db.get_setting(conn, 'last_reply_scan') or 'never'}")
    elif a.cmd == "pause":
        replies.pause(conn, a.reason)
        print(f"paused: {a.reason}")
    elif a.cmd == "resume":
        # Resuming is Sai's call after he's looked at the bounces, so they stop re-triggering the pause.
        for d in (today_ct() - dt.timedelta(days=1), today_ct()):
            db.set_setting(conn, f"bounce_ack_{d}", str(replies.bounce_rate(conn, d)[0]))
        db.set_setting(conn, "paused", None)
        db.log_event(conn, None, "resumed", "")
        conn.commit()
        print("sending resumed")
    elif a.cmd == "install-launchd":
        print(f"installed {install_launchd()}")
    conn.commit()


if __name__ == "__main__":
    main()
