# Outreach system

Sai finds a manual workflow at a Birmingham-area company, builds a demo, and gets paid to set it up and run it.
This folder turns that into short commands. Run `claude` from inside this `outreach/` folder.

Who Sai is, the exact proof line, the offer, pricing, availability and active deals live in a private file
that is not in git (this repo is public):

@profile.local.md

If `profile.local.md` or `sender.local.json` is missing, stop and tell Sai. Don't guess his details.

## Hard rules (always)

- Never send a reply, meeting confirmation, proposal, or price to a prospect without Sai's explicit approval
  in this chat. Record his words with `drafts.py send-reply ID --approval "..."`.
- Never invent facts, results, clients, or numbers. If you can't verify it on a real page, leave it out.
- Never email anyone on the suppression list or anyone already contacted. `db.py check` before research,
  `send_blockers` runs again at draft time and right before every send.
- Never touch Gmail drafts or emails this system didn't create. `gmail.py` only acts on draft ids stored in the
  `emails` table. The old Wave 3 drafts sitting in Gmail are not ours: leave them alone.
- Never print or commit tokens or credentials. Don't `cat` anything in `secrets/`.
- Never delete any email or data. Archive (`db.py archive`) or change status instead, and tell Sai.
  There is no delete or trash call anywhere in `scripts/`; keep it that way.
- If something fails twice, stop and tell Sai what you tried instead of looping.
- Stop at each approval gate and wait.

## Voice (every email)

Follow the `sai-voice` skill if it's available. On top of it:

- Short, plain sentences. A sharp high school senior, not a marketer. Uneven sentence length, front-load the point.
- No em dashes. No exclamation points. No emoji. No "I hope this finds you well", "leverage", "streamline",
  "game-changer", "revolutionize", "I wanted to reach out", "feel free to", "that said".
- First touch = one specific observation from a real source, one specific workflow AI would fix, the proof line,
  one clear ask. Under 120 words before the sign-off. Template: `templates/first_touch.md`.
- Subject names the workflow and the company: "Quote drafts for Oak Street Roofing".
- Strictly AI automation. Never ads, social media, or content creation.
- `scripts/voicecheck.py` enforces most of this and blocks the draft if it fails. Fix the email, don't bypass it.

## Sending rules (deliverability and law)

- Max 25 emails per weekday from Gmail, follow-ups included, sent 7:45 to 9:30 AM Central, 2 to 5 minutes apart
  at random. launchd on the Mac runs `scheduler.py run`; the Mac just has to be awake.
- Sending stops by itself and Sai gets a notification if bounces go over 3% of a day's sends, Gmail returns any
  rate-limit or spam signal, or two sends fail in a row. Only Sai resumes it (`scheduler.py resume`).
- If more than 5 meetings are pending (`meeting_pending` + `meeting_booked`), new first-touch sends pause.
  Follow-ups still go. Tell Sai.
- CAN-SPAM: honest subject, Sai's real name, his postal address in the signature, and this exact last line on
  every cold email and follow-up: "If this isn't useful, reply 'no thanks' and I won't email again."
  The scripts add it. A missing `postal_address` in `sender.local.json` blocks every cold draft.
- Any "no thanks", "remove me", or "unsubscribe" reply is suppressed the moment it's seen and never emailed again.
- Exactly one follow-up, in the same thread, 8 business days after the first email, only if there's no reply.
  Text: `templates/follow_up.txt`, word for word.

## Commands

| Command | What it does |
|---|---|
| `/status` | Terminal dashboard: counts by status, sends this week, reply rate, meetings, next steps, overdue. |
| `/doctor` | Preflight: is this Mac ready to draft and send? Says exactly what to fix. |
| `/campaign` | Part 2 end to end with helper agents: refresh, research to 200, draft, review. Stops at gate 2. |
| `/prospect N [sector]` | Research N new Birmingham-metro companies with a published email, a workflow and evidence. |
| `/refresh` | Re-verify the old `todo` pool: site and email still work, workflow still makes sense. Keep or drop. |
| `/draft` | First-touch Gmail drafts (resume attached) for every verified company without one. |
| `/review` | Builds the review page. Sai approves, edits or cuts each draft. |
| `/send` | Schedules approved drafts into the 25-a-day plan. |
| `/followup` | Queues the one follow-up for anyone at 8 business days with no reply. |
| `/replies` | Reads replies, classifies them, drafts answers with real open times. Never sends. |
| `/morning` | Weekday routine after the send window: `/followup`, `/replies`, then the 5-line report. |
| `/prep {company}` | One-page meeting brief + a working single-page demo on sample data. |
| `/debrief {recording}` | Local transcript, honest debrief, price recommendation, follow-up draft. |

## Statuses

Pipeline: `todo` (old research, unverified) → `verified` → `drafted` → `approved` → `queued` → `emailed`
→ `followed_up`. Replies: `replied` (unclassified), `replied_question`, `replied_interested`, `not_now`,
`replied_no`, `unsubscribed`, `bounced`. Deals: `meeting_pending` (times proposed), `meeting_booked`, `call`,
`proposal`, `won`, `lost`. Closed without contact: `dropped` (failed refresh), `cut` (cut in review), `archived`.
Anything from `emailed` onward is never cold-emailed again.

`reply_class = unreviewed` means Gmail shows a message from them that the history CSV never recorded.
`/replies` reads those threads too.

## Files

- `data/outreach.db`: SQLite. Tables `companies`, `contacts`, `emails` (every draft this system made, the
  ownership record), `events` (log of everything), `suppression`, `inbound` (replies seen), `settings`.
- `data/import/`: `prospects_history.csv`, `active_deals.json`, `sent_sweep.csv`, and the JSON batches you write.
- `scripts/`: `db.py`, `gmail.py`, `drafts.py`, `voicecheck.py`, `review.py`, `scheduler.py`, `replies.py`,
  `availability.py`, `status.py`, `transcribe.py`. Run them with `python3 scripts/<name>.py --help`.
- `templates/`, `demos/{company}/`, `meetings/{date}-{company}/`, `reports/` (daily reports, send log, alerts).
- `SETUP.md`: one-time Mac setup (Python, Gmail OAuth, launchd, wake schedule).

Gmail: `scripts/gmail.py` (OAuth on the Mac) is the only thing that creates or sends mail, because it attaches
the resume and records ownership. The claude.ai Gmail and Calendar connectors, if this session has them, are
fine for reading (checking a thread, free/busy). Never use a connector to send, and never to touch a draft.

Back up before any bulk change: `python3 scripts/db.py backup`.
