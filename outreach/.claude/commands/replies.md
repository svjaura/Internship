---
description: Check Gmail for replies, classify them, update the database, and draft answers for Sai to approve
---
Read CLAUDE.md first. Nothing here sends anything without Sai's explicit OK in this chat.

1. `python3 scripts/replies.py scan`. Bounces, out-of-office, "remove me" and "no thanks" are handled
   automatically (suppressed immediately). Note anything it says about a pause.
2. `python3 scripts/replies.py pending` lists messages that need a read. Also check past-wave threads Gmail
   flagged: `sqlite3 data/outreach.db "SELECT id, legacy_thread_id FROM companies WHERE reply_class = 'unreviewed'"`.
3. For each, read the whole thread: `python3 scripts/gmail.py thread THREAD_ID` (or the Gmail connector's
   get_thread, read-only). Classify as one of: interested, question, not_now, no, out_of_office, bounce, remove_me.
   Record it: `python3 scripts/replies.py classify MESSAGE_ID CLASS --summary "one line" [--next-step "..." --due YYYY-MM-DD]`.
   For an `unreviewed` past-wave thread, set it directly:
   `python3 scripts/db.py set ID status=<status> reply_class=<class> reply_summary="..."`.
4. Interested or question: draft the answer with `templates/reply_interested.md` / `reply_question.md`.
   Get real times: `python3 scripts/availability.py --count 3` (Sai's free windows minus his Google Calendar;
   if the OAuth calendar call fails, fetch busy blocks with the Calendar connector and pass `--busy-json`).
   Save it as a Gmail reply draft: `python3 scripts/drafts.py reply COMPANY_ID --thread THREAD_ID --body-file reply.txt`.
   Set `db.py set ID status=meeting_pending` once times are proposed.
5. Show Sai each reply draft in full (to, subject, body) with one line on what they said. Then stop and wait.
   Only after he says to send that specific draft: `python3 scripts/drafts.py send-reply EMAIL_ID --approval "<his words>"`.
   Never put a price, a proposal, or a meeting confirmation in a reply he hasn't approved.
6. When a time is confirmed: `python3 scripts/db.py set ID status=meeting_booked meeting_at=YYYY-MM-DDTHH:MM`
   and offer to add it to his Google Calendar (only with his OK). Run /prep the day before.
