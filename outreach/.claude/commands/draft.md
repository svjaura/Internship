---
description: Write first-touch emails for verified companies and save them as Gmail drafts with the resume attached
---
Write first-touch drafts for every `verified` company that doesn't have one yet. Read CLAUDE.md and
`templates/first_touch.md` first, and follow the `sai-voice` skill if it's available.

1. Check `python3 scripts/status.py` says the postal address is set and Gmail login is set up. If not, stop and tell Sai.
2. Get the list: `sqlite3 data/outreach.db "SELECT id FROM companies WHERE status = 'verified'"` (or `db.py list --status verified --limit 500`).
3. For each company, `python3 scripts/db.py show ID`. Re-open the evidence URL if you need the exact wording.
   Write:
   - `greeting_name`: first name, or the title they use ("Pastor Steve", "Dr. Smith"). No named contact → "{Short company} team".
   - `short_name`: what a person would call them ("Oak Street Roofing", not "Oak Street Roofing Company, LLC").
   - `workflow_short`: 2 to 5 lowercase words for the demo ("rate comparisons", "estimate follow-ups").
     The follow-up reuses it: "I'd still like to build {short_name} a quick demo of {workflow_short}."
   - `subject`: "{Workflow short, capitalized} for {short_name}".
   - `body`: greeting through the ask, under 120 words. Use `intro_line` and `proof_line` from
     `sender.local.json` exactly. The sign-off, signature, address and opt-out get added for you.
   Only facts you saw on their pages. No numbers you can't point to.
4. Save batches of 25 to `data/import/drafts-YYYYMMDD-N.json` (list of objects: id, greeting_name, short_name,
   workflow_short, subject, body) and run `python3 scripts/drafts.py create <file>`.
5. Anything SKIPPED failed the voice or suppression check: fix the email (not the rule) and rerun just those.
   If the same one fails twice, leave it and list it for Sai.
6. Report how many drafted by bucket, how many skipped and why, then tell Sai to run /review.
