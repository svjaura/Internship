---
description: Weekday routine after the 7:45 send window - follow-ups, replies, then a 5-line report
---
Run on weekdays after 9:30 AM CT.

1. Check `reports/` for today's run log and `reports/alerts.log` for anything new. If sending paused, lead with that.
2. Run /followup, then /replies (classify, draft answers, but don't send).
3. Any meeting booked for tomorrow (`status = meeting_booked` with `meeting_at` tomorrow)? Run /prep for it and say so.
4. Finish with exactly five lines, from `python3 scripts/scheduler.py report` plus what you just did:
   sent, replies, interested, meetings proposed, and anything that needs Sai.
