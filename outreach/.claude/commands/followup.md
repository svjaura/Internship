---
description: Queue the one follow-up for sent emails at 8 business days with no reply
---
The 7:45 AM run does this by itself every send day. Use this to preview or catch up.

1. `python3 scripts/replies.py scan` first, so anyone who replied is out of the follow-up list.
2. `python3 scripts/scheduler.py followups --dry-run` and show who's due.
3. `python3 scripts/scheduler.py followups` to create the follow-up drafts in the same threads (text from
   `templates/follow_up.txt`, word for word) and queue them for the next send window. They count toward the 25.
4. Past-wave contacts (emailed before this system existed) are left out unless Sai has said to include them:
   then use `--include-legacy`.
