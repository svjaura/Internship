---
description: Part 2 end to end - refresh the old pool, research to 200, draft them all, open the review page (stops at gate 2)
---
Run the 200-company campaign. Read CLAUDE.md and CAMPAIGN.md first. Keep Sai posted with one short line per
stage. This stops at Approval Gate 2; nothing is queued or sent.

**0. Preflight.** `python3 scripts/doctor.py --online`, then `python3 scripts/db.py backup`.
Drafting needs the postal address and the Gmail login. If either is missing, still do stages 1 and 2, then stop
and tell Sai what to fix before stage 3.

**Helper agents.** Stages 1 to 3 fan out to subagents (Agent tool, background, at most 4 running at once) so
this takes an afternoon instead of a week. Every brief must say:
- Work only from pages you open yourself (WebFetch). Never guess an email address. A site that fails twice: skip it.
- Write results to the JSON file named in the brief. Don't touch the database, Gmail, or any other file.
- Run `python3 scripts/db.py check EMAIL --website DOMAIN` before researching a company; skip anything it flags.
You are the only one who writes to the database (SQLite has one writer): apply each file as it comes back.

**1. Refresh the old pool.**
- Write `data/import/refresh-drops.json` yourself: every `todo` row with fit Low, or sector "Already talking AI",
  as `{"id": ..., "verdict": "drop", "reason": ...}`. No research needed.
- Split the old `todo` rows that have an email (High/Medium) into batches of about 25 ids, plus one batch of the
  professional and field rows that have no email. One agent per batch, briefed with steps 2 and 3 of
  `.claude/commands/refresh.md` and its id list (include each row from `db.py show`), writing
  `data/import/refresh-<n>.json`.
- Apply each: `python3 scripts/db.py refresh-apply <file> --wave campaign-nov`. Fix rejects once.
  Leave nonprofit/other rows without an email as `todo`.

**2. Research new companies to 200.**
- `python3 scripts/db.py mix` gives the gaps. Brief one agent per slice with steps 2 to 4 of
  `.claude/commands/prospect.md`, a target count, its cities, and its output file `data/import/prospects-<slice>.json`:
  mortgage brokers + insurance agencies; CPA/bookkeeping + law + title; HVAC/plumbing/electrical/roofing/garage
  doors; pest/lawn/landscaping/cleaning/restoration/moving; and one "other" slice (distribution, freight,
  dental/chiro/PT/vet offices, local retail) if that bucket is short. Ask for about 20 percent more than the gap,
  since some get rejected as duplicates.
- Apply each: `python3 scripts/db.py add-prospects <file> --wave campaign-nov`. Re-run `mix` and send one more
  round for any bucket still short. Stop when verified hits about 200, with nonprofit capped at 40 (the strongest
  40 get drafted, the rest stay `verified` for the next wave).

**3. Draft all of them.**
- Split the verified companies into batches of 25. One agent per batch, briefed with `templates/first_touch.md`,
  the voice rules from CLAUDE.md (and the `sai-voice` skill), the `intro_line` and `proof_line` from
  `sender.local.json`, and each company's row. It writes `data/import/drafts-<n>.json` in the format
  `.claude/commands/draft.md` describes, and checks each body with
  `python3 scripts/voicecheck.py --company ID --subject "..." --body-file <tmp file>` before saving.
- Apply each: `python3 scripts/drafts.py create <file>`. That makes the Gmail drafts with the resume attached.
  Fix SKIPPED ones once yourself; list any that fail twice.

**4. Review.** Run /review and give Sai a short summary: drafted by bucket and fit, anything skipped and why.
Then stop. This is Approval Gate 2.
