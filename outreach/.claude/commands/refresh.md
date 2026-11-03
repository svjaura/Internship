---
description: Re-verify the old todo pool (site, email, workflow) and keep or drop each one
argument-hint: [how many, default all]
---
Refresh the old `todo` companies ($ARGUMENTS of them, or all). Read CLAUDE.md first. Back up first:
`python3 scripts/db.py backup`.

1. List them: `python3 scripts/db.py list --status todo --limit 500`. Work in batches of about 20.
2. For each one, `python3 scripts/db.py show ID`, then open the website and the page where the email was found.
   - Site dead, parked, or company closed/moved out of the metro: drop.
   - No published email anywhere (the old row has none, or it's gone): look once on the contact page, team page,
     a job post, or the chamber listing. Found and visible on a page → keep with the new address and that page's URL.
     Not found → drop. Never guess an address.
   - Workflow no longer makes sense, it's an internal nice-to-have, or they now clearly use a vendor for it:
     rewrite it to a revenue-tied workflow you can see evidence for, or drop.
   - Franchise with corporate IT, hospital, big bank, government, or the "Already talking AI" crowd (IT shops,
     agencies that sell AI): drop.
   - Re-score fit. Low → drop.
   The old draft emails are about 3 weeks stale. Don't reuse them; /draft writes fresh ones.
3. Write verdicts to `data/import/refresh-YYYYMMDD-N.json`: a list of objects with `id`, `verdict` ("keep" or
   "drop"), `reason` (for drops), and for keeps any updated fields: email, email_source_url, contact_name,
   contact_role, workflow, why_pay, evidence, source_urls, fit, short_name, website, city, sector, kind, size_signal.
   A keep must end up with email, email_source_url, workflow, why_pay and evidence.
4. Run `python3 scripts/db.py refresh-apply <file> --wave campaign-nov`. Fix anything it rejects (usually a
   duplicate domain or a missing field).
5. Report: kept N, dropped N (top reasons), then `python3 scripts/db.py mix`.
