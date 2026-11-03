# First-touch email

Under 120 words (the sign-off, signature, address and opt-out are added by `drafts.py` and don't count).
Four beats, in this order, nothing else:

1. **One specific observation** about their business, from a real page you opened (their site, a job post,
   a chamber listing, a Google review). Plain fact, no flattery. Save the URL as evidence.
2. **Who you are + the one workflow** AI would fix for them, in their words, tied to revenue when possible
   (quotes, lead follow-up, scheduling, paperwork re-entry).
3. **The proof line**, copied exactly from `sender.local.json` → `proof_line`. Never reword the number.
4. **One clear ask**: a quick demo built for them, shown after school or over Zoom. Mention the resume is attached.

Subject: `{Workflow short} for {Short company}`, e.g. "Quote drafts for Oak Street Roofing". Honest, names
the workflow and the company, no "Re:", no tricks.

## Skeleton

```
Hi {greeting_name},

{Observation: one or two short sentences about something real on their site or listing.}

{intro_line} {The workflow, said plainly: what AI would do, and what changes for them.}

{proof_line}

My resume is attached. Could I build {short_company} a quick demo of {workflow_short} and show you after school or over Zoom?
```

## Example (made-up company, structure only; the facts in a real one come from their real pages)

```
Hi Dana,

Your estimate page says every roof quote goes out by hand within 48 hours of the inspection.

{intro_line} I'd set up AI to turn your inspection notes into a draft quote and email, so you just check it and hit send.

{proof_line}

My resume is attached. Could I build Oak Street Roofing a quick demo of inspection-to-quote drafts and show you after school or over Zoom?
```

## Never

- Em dashes, exclamation points, emoji, "hope this finds you well", "leverage", "streamline", "game-changer",
  "revolutionize", "I wanted to reach out", "feel free to", "that said". (`voicecheck.py` blocks these.)
- Any number, client, or result you didn't read on a real page. If you can't verify it, leave it out.
- Ads, social media, content creation. The offer is AI automation only.
- "Free trial" or "free first version". The demo is the only free part.
- A second ask or a P.S.
