---
description: Research N new Birmingham-metro companies with a published email, one manual workflow and evidence
argument-hint: N [sector]
---
Research $ARGUMENTS (first word = how many, the rest = optional sector focus). Read CLAUDE.md first.

1. Run `python3 scripts/db.py mix` and favor the buckets that are short of target (professional services 30%,
   field service and trades 25%, nonprofits and schools 20%, everything else 25%) unless a sector was given.
2. Find companies in Birmingham, Hoover, Homewood, Vestavia Hills, Mountain Brook, Trussville, Pelham, Alabaster
   or Bessemer. Good sources: the company's own site, chamber of commerce member directories, local job posts,
   state licensing directories. Skip franchises with corporate IT, hospitals, big banks, government, and
   anything already known: run `python3 scripts/db.py check EMAIL --website DOMAIN` before you dig in.
3. For each company you keep, open the pages yourself (WebFetch) and record:
   - a real, published contact email you saw on their site, a job post, or a chamber listing, plus that page's URL.
     Never guess an address from a pattern. If no address is published, skip the company.
   - a named decision maker (owner, office manager, director) when the site or listing names one.
   - one specific manual workflow, in their words, and why they'd pay (tie it to revenue: quotes, lead
     follow-up, scheduling, paperwork re-entry beat internal nice-to-haves).
   - evidence: what on the page shows the workflow (a "call for a quote" form, "allow 48 hours", a job post for
     data entry, a PDF intake form), with the source URLs.
   - a size signal (staff count from the team page, locations).
   - fit: High = owner-run or small team, workflow visible in public material, revenue-tied, decision maker named.
     Medium = most of that. Low = corporate IT, no clear workflow, or no email. Keep only High and Medium.
4. Write them to `data/import/prospects-YYYYMMDD-HHMM.json` as a list of objects with keys: company, short_name,
   website, city, sector, kind, size_signal, contact_name, contact_role, email, email_source_url, phone,
   workflow, why_pay, evidence, source_urls (list), fit, notes.
5. Run `python3 scripts/db.py add-prospects <file> --wave campaign-nov`. It dedupes by domain AND email against
   the whole database and the suppression list and rejects anything that collides.
6. Report: added N (by bucket and fit), rejected N with the reason for each. Don't draft anything yet.

Batch the work: research and save in groups of about 10 so nothing is lost if a fetch fails. If a site won't
load twice, skip it and say so.
