---
description: Build the review page for all pending drafts so Sai can approve, edit or cut each one
---
1. Run `python3 scripts/review.py build`, then start the local review server in the background:
   `python3 scripts/review.py serve` (it serves http://127.0.0.1:8765 and saves each click straight to the database).
2. Tell Sai: open http://127.0.0.1:8765 . Each card shows the company, contact, where the email address came from,
   the workflow, the evidence, and the full email. Approve, Edit (re-checked against the voice rules on save),
   or Cut. If he opens `review.html` as a plain file instead, the page saves decisions in the browser and gives
   him a "Download decisions" button; then run `python3 scripts/review.py apply ~/Downloads/review_decisions.json`.
3. This is an approval gate. Wait for Sai to say he's done. Then run `python3 scripts/drafts.py pending` and
   report approved / edited / cut / still pending. Nothing is queued without his approval; queueing is /send.
