---
description: Transcribe a meeting recording locally and write an honest debrief with a price and follow-up draft
argument-hint: {path to recording}
---
Debrief the meeting recording at $ARGUMENTS.

1. Make `meetings/YYYY-MM-DD-{company-id}/` and move or copy the recording there.
2. Transcribe locally: `python3 scripts/transcribe.py <recording>` (first time: `python3 -m pip install faster-whisper`).
   Audio stays on the Mac. If it fails twice, stop and say what happened.
3. Read the transcript and the company's row and thread. Write `meetings/.../debrief.md` with:
   - Summary (5 lines).
   - What they actually need (their words, with timestamps), which may differ from what Sai pitched.
   - What Sai did well (specific moments).
   - What to fix next time (specific, kind, short).
   - Chance of getting paid: a percentage with the reasons for and against.
   - Recommended price using the ranges in `profile.local.md`, scoped to what they said. Half up front, half when it works.
   - Next step and when.
4. Draft the follow-up email in Sai's voice (recap their need in one line, what he'll build, next step). If the
   company has a tracked thread, save it as a reply draft with `drafts.py reply`; otherwise save it to
   `meetings/.../follow_up.txt`. Show it to Sai. Don't send it, and don't include a price unless he approves it.
5. Update the database: `db.py set ID status=... next_step="..." next_step_due=...` and `db.py note ID "..."`.
