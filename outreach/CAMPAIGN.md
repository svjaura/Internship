# Part 2: the 200-company campaign

Wave name: `campaign-nov`. Mix target (from `config.json`): professional 60, field 50, nonprofit 40, other 50.

## Where the old pool stands (Oct 28 import)

| Old `todo` rows | professional | field | nonprofit | other | total |
|---|---|---|---|---|---|
| High/Medium, has email | 7 | 1 | 53 | 47 | 108 |
| High/Medium, no email | 14 | 21 | 13 | 37 | 85 |
| Low fit | | | | | 54 |

The old pool can cover nonprofit and most of "other". Professional services and field service mostly have to
come from new research.

## Steps

`/campaign` runs all of this with helper agents and stops at the review gate. The manual version:

1. `python3 scripts/db.py backup`.
2. `/refresh` on the 108 with an email. Re-verify site, email and workflow; keep or drop.
3. `/refresh` on the 35 professional + field rows with no email: look once for a published address
   (contact page, team page, job post, chamber listing). Found → keep. Not found → drop.
   The 50 nonprofit/other rows with no email stay `todo` for a later wave (those buckets are already full).
4. Drop the 54 Low-fit rows and the "Already talking AI" rows in the same refresh file (`"verdict": "drop"`).
5. `python3 scripts/db.py mix`, then `/prospect` per short bucket until verified hits the target, about:
   - professional: ~50 new (independent mortgage brokers, independent insurance agencies, CPA and bookkeeping
     firms, small law firms, title companies)
   - field: ~40 new (HVAC, plumbing, electrical, roofing, garage doors, pest, lawn and landscaping, cleaning,
     restoration, moving)
   - other: ~10 new (distribution, freight, dental/chiro/PT/vet offices, local retail)
   Favor revenue-tied workflows: quotes, lead follow-up, scheduling, paperwork re-entry.
6. If nonprofit ends above 40 verified, draft the 40 strongest (High fit, revenue-tied workflow) and leave the
   rest `verified` for the next wave.
7. `/draft`, then `/review`. Approval gate 2: stop and wait for Sai.

Research needs open web access (the company sites themselves), so run it where outbound browsing works.
