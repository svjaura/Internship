---
description: One-page meeting brief plus a working single-page demo on sample data
argument-hint: {company id or name}
---
Prepare for the meeting with $ARGUMENTS. Read CLAUDE.md and `profile.local.md` (offer and pricing).

1. Find the company: `python3 scripts/db.py show ID` (use `db.py list` or sqlite to find the id). Read every
   email in the thread (`python3 scripts/gmail.py thread THREAD_ID`) and re-open their website.
2. Write `demos/{id}/brief.md`, one page:
   - What they do (2 lines, from their site).
   - The workflow, as they described it in the thread, and what it costs them now (only numbers they gave).
   - Questions to ask (5 or fewer): volumes, the tools they already use, who touches it, what "done" looks like,
     who decides.
   - What to show, in order, in under 10 minutes.
   - Pricing range from `profile.local.md` that fits the scope (small work hourly, or setup + monthly), with
     one line on why. Half up front, half when it works. Say it out loud only if they ask.
3. Build `demos/{id}/index.html`: one self-contained page that actually works in a browser (paste or load sample
   input, click, see the output the automation would produce: a drafted email, a filled form, a comparison
   table, a report). Rules:
   - Sample data only. A visible "Sample data" label at the top. No real customer names or numbers.
   - Clean, plain design that doesn't look AI-made: no gradients, no glow, no emoji icons, no Inter or Roboto.
     Use a system serif or `ui-sans-serif` stack, one accent color, real table borders, generous spacing.
   - Works offline, no external scripts unless pinned from cdnjs.
4. Optional: if the Miro connector is available and a flow diagram would help, make a small board of the
   before/after workflow and link it in the brief.
5. Tell Sai where both files are and the three things to say first.
