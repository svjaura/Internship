# Refi Watch (Weber Mortgage)

A working model of Refi Watch: a borrower connects their mortgage through Plaid (Liabilities),
the staff dashboard shows the servicer's real numbers, and Michael's rule decides
**Ready**, **Watch**, **Not yet** or **Reconnect**. Due Friday, Nov 20, 2026.

## Go live in 20 minutes

`<domain>` is the Vercel production domain, for example `refi-watch.vercel.app`. Never paste a
key into chat, a text or a commit.

### a. Supabase

1. **Schema.** Table Editor should list `orgs`, `staff_members`, `borrowers`, `plaid_items`,
   `loans`, `org_settings` and `audit_log`. If it does, the migrations are already applied
   (they may have been applied through the Supabase MCP): go to step 2. If not, SQL Editor:
   run `supabase/migrations/0001_init.sql`, then `supabase/migrations/0002_harden_functions.sql`.
2. **Two-factor.** Authentication > Multi-Factor: TOTP (authenticator app) **enabled**.
3. **No public sign-ups.** Authentication > Sign In / Providers: turn **off** "Allow new users to sign up".
4. **Add Sai.** Authentication > Users > Add user > Create new user: Sai's email, a strong
   password, tick **Auto Confirm User**. Open the new user and copy its **UID**.
5. **Org and staff row.** SQL Editor: paste `supabase/seed_weber.sql`, replace
   `PASTE-USER-UID-HERE` and `PASTE-USER-EMAIL-HERE` with Sai's UID and email, run. The result
   must show one row: `Weber Mortgage | <Sai's email> | owner | 1`.
6. **URLs.** Authentication > URL Configuration: Site URL `https://<domain>`, and add
   `https://<domain>/**` to Redirect URLs.
7. **Keys for Vercel.** Project Settings > API Keys: the **publishable** key (`sb_publishable_...`)
   and a **secret** key (`sb_secret_...`). The project URL is under the **Connect** button
   (`https://<ref>.supabase.co`). The Legacy API Keys tab's `anon` / `service_role` keys work too.

### b. Vercel

1. Add New > Project > import the GitHub repo. **Root Directory: `refi-watch`**. Framework
   Preset: **Next.js**. Leave the build settings alone.
2. Before the first deploy, add these Environment Variables (Production):

   | Variable | Value | Where it comes from |
   |---|---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` | Supabase, step a.7 |
   | `SUPABASE_ANON_KEY` | `sb_publishable_...` (or legacy `anon`) | Supabase, step a.7. Public by design. |
   | `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` (or legacy `service_role`) | Supabase, step a.7. Server only. |
   | `TOKEN_ENCRYPTION_KEY` | output of `openssl rand -base64 32` | Generate once. **Save it in the password manager first**, then paste. Never change it: stored Plaid tokens only decrypt with this key. |
   | `PLAID_CLIENT_ID` | | Weber Mortgage's Plaid Dashboard > Developers > Keys |
   | `PLAID_SECRET_SANDBOX` | | same page, Sandbox secret |
   | `PLAID_SECRET_PRODUCTION` | | same page, Production secret (the Trial plan's) |
   | `PLAID_ENV` | `sandbox` | becomes `production` in step d.4 |
   | `PLAID_WEBHOOK_URL` | `https://<domain>/api/plaid/webhook` | the production domain, never a preview URL |
   | `BORROWER_REFI_VIEW` | `false` | stays false until Michael approves the wording |

   Optional: `PLAID_REDIRECT_URI` = `https://<domain>/connect/oauth` (OAuth banks on phones; add
   the same URI in Plaid, step c.2) and `PRIVACY_NOTICE_URL` (an https link shown on the consent page).
3. Deploy. If you only learn `<domain>` now, set `PLAID_WEBHOOK_URL` and Redeploy (env changes
   need a redeploy).
4. Open `https://<domain>/api/health`. It must show `"ok": true` and `"plaid_env": "sandbox"`.
   If not, `problems` names each variable to fix (never its value). `npm run check-env` runs
   the same check locally on `.env.local`. If the page asks you to log in to Vercel instead, that
   URL is protected and Plaid and Michael's phone can't reach it either: use the production
   domain, or relax Settings > Deployment Protection for production.

### c. Plaid (Weber Mortgage's own account, Trial plan)

1. **Never apply for Production access** and never click Upgrade: that ends the free Trial
   (10 real connections, Liabilities included). The Trial's Production secret already works.
   A removed connection does not free its slot.
2. Webhook: nothing to set in the Plaid dashboard. The app sends `PLAID_WEBHOOK_URL` with every
   Link token. Only if you set `PLAID_REDIRECT_URI`: add the same URI under Developers > API >
   Allowed redirect URIs.

### d. Test in Sandbox, then switch to production

1. On your laptop, put `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX` and `PLAID_WEBHOOK_URL` in
   `refi-watch/.env.local` (git-ignored), then:

   ```bash
   npm install
   npm run sandbox:e2e
   ```

   It must end with `PASSED`, after printing the servicer's fields, current P&I and how it was
   figured, new P&I, savings, payback, status and reason. It never writes to Supabase. Then in
   Vercel > Logs, within a minute: `plaid webhook for an unknown item` means Plaid reached the
   app and the signature checked out (that sandbox item only exists on your laptop);
   `plaid webhook rejected` means it didn't.
2. On the live site: `https://<domain>/login`, sign in as Sai, scan the QR code with an
   authenticator app, enter the code. On the dashboard, invite "Sandbox Test", open the link,
   connect **First Platypus Bank** as `user_good` / `pass_good`. The loan appears, labeled "From
   the servicer, through Plaid". (Sandbox's mortgage has old dates, so its math only proves the
   wiring. Sandbox never uses a Trial slot.)
3. Remove the test borrower (and its sandbox connection and loan), SQL Editor:
   `delete from public.borrowers where full_name = 'Sandbox Test';` (the name you used in step 2).
4. Vercel > Settings > Environment Variables: `PLAID_ENV` = `production`. Deployments > latest >
   Redeploy. `/api/health` must now show `"plaid_env": "production"` and `"ok": true`.
5. Dashboard > Invite a borrower: "Michael Weber". Copy the link, text it to Michael yourself,
   and keep it (it's also his reconnect link). **One invite, one connection**: don't create a
   second invite for him or ask him to connect again "to try".

### e. Acceptance check against Michael's Rocket statement

| Dashboard | Rocket statement | Expect |
|---|---|---|
| Interest rate, Fixed/ARM | Interest rate | exact match |
| Next due | Payment due date | match |
| Monthly payment (from Plaid) | **Total** monthly payment | match. Plaid's figure includes escrow. |
| Current P&I (Calculated) | Principal + interest | within a few cents. P&I is calculated, from the note, or from the balance if Rocket doesn't report the original amount and term (the drawer says which). |
| Current balance | Principal balance | close; can be one payment apart depending on dates |

Then enter today's rate and closing costs in the rule panel: the loan's drawer shows new P&I,
monthly savings and payback, and his rule sets the status. Logging in must ask for the
authenticator code. "Updated" changes on its own when Plaid sends `DEFAULT_UPDATE`.

### If something breaks

- `https://<domain>/api/health` first: it names any missing or malformed setting.
- Then Vercel > the project > Logs.
- `REFIWATCH_UNSAVED_ITEM` in the logs: a borrower connected but the database refused the save
  twice. The connection is not lost; their page told them to call, not to connect again. Fix the
  database, put the live `TOKEN_ENCRYPTION_KEY`, `SUPABASE_*` and Plaid production keys in
  `.env.local` (with `PLAID_ENV=production`), copy the whole log line, and from `refi-watch/`:

  ```bash
  npx tsx scripts/recover-item.ts --dry-run 'REFIWATCH_UNSAVED_ITEM {...}'
  npx tsx scripts/recover-item.ts 'REFIWATCH_UNSAVED_ITEM {...}'
  ```

  It checks the token decrypts with your key, inserts the item, and loads the loan.
- Status "Reconnect needed": text the borrower the same connect link. It opens Plaid in update
  mode: same connection, no new slot.

## Run it locally (no keys needed)

```bash
npm install
npm run dev          # http://localhost:3000/dashboard
npm test             # vitest: rule engine, crypto, Plaid mapping, webhook, end-to-end flow, scripts
npm run typecheck    # tsc --noEmit
npm run lint
npm run build
npm run check-env    # go-live env check on the shell + .env.local (never prints values)
npm run sandbox:e2e  # Plaid Sandbox end to end (needs the Sandbox keys)
```

With no env vars set the app runs in **local test mode**:

- `/dashboard` serves the demo's 13 test loans (Jordan Avery plus L01 to L12) from memory,
  checked as of the demo date, Mon Nov 9, 2026, so every number matches the demo.
- Staff login and two-factor are off, and a banner says so. Test mode is refused on a Vercel
  production deployment, so a missing env var can never open the dashboard there.
- `/connect/demo-invite-0001` shows the borrower consent page; "Connect with Plaid" simulates
  the Plaid step and says it is test mode.

## Pages and routes

| Path | What it is |
|---|---|
| `/connect/[invite]` | Weber-branded consent page: exactly what is shared, consent checkbox, **Connect with Plaid**, success screen. No refinance numbers. |
| `/connect/oauth` | Return page for OAuth banks (Chase, Wells Fargo, Bank of America). |
| `/dashboard` | Staff only, two-factor. Rule panel, KPI cards, loans table with source labels, detail drawer with the math, invite links, CSV export. |
| `/login` | Staff email + password, then a TOTP code (enrolls an authenticator on first login). |
| `POST /api/plaid/link-token` | Link token: `products: ["liabilities"]`, mortgage accounts only, `country_codes: ["US"]`, webhook. Update mode for Reconnect. |
| `POST /api/plaid/exchange` | `public_token` to `access_token`, encrypted (AES-256-GCM) with the `item_id`, then the first `/liabilities/get`. If the save fails twice, logs a recoverable `REFIWATCH_UNSAVED_ITEM` line (token encrypted). |
| `POST /api/plaid/webhook` | Verifies the `Plaid-Verification` JWT, then refreshes (LIABILITIES `DEFAULT_UPDATE`) or flags Reconnect (ITEM `ERROR` `ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`). |
| `GET /api/health` | Setup check: which env vars are present (booleans), `PLAID_ENV`, named problems. No values, no network calls. |
| `PUT /api/settings`, `GET /api/export`, `POST /api/invites`, `POST /api/audit/login` | Staff APIs. Every login and export goes to `audit_log`. |

## Key files

```
src/lib/rules.ts         Rule engine ported from demo/index.html (monthlyPI, scheduledInterest, evaluate, reasonText)
src/lib/demo-data.ts     The demo's 13 test loans and its buildServicerRecord()
src/lib/plaid.ts         Plaid client (PLAID_ENV sandbox|production) and the four Plaid calls
src/lib/plaid-map.ts     Data minimization: /liabilities/get -> only the allowed fields
src/lib/plaid-webhook.ts Webhook JWT verification and webhook -> action mapping
src/lib/refresh.ts       Refresh one Item: decrypt token, /liabilities/get, save loans
src/lib/crypto.ts        AES-256-GCM for access tokens (TOKEN_ENCRYPTION_KEY)
src/lib/db.ts            Data access: Supabase (service role, server only) or in-memory demo data
src/lib/auth.ts          Staff check: verified session, aal2, staff_members row
src/lib/env-check.ts     Go-live env check behind /api/health and npm run check-env
src/lib/unsaved-item.ts  The REFIWATCH_UNSAVED_ITEM log line (format and parse)
src/proxy.ts             Next 16 "proxy" (was middleware): /dashboard requires aal2
scripts/sandbox-e2e.ts   npm run sandbox:e2e (logic in src/lib/sandbox-e2e.ts)
scripts/recover-item.ts  Put an unsaved item back from its log line (logic in src/lib/recover-item.ts)
scripts/check-env.ts     npm run check-env
supabase/migrations/     0001_init.sql (schema, org_id everywhere, RLS with membership + aal2), 0002_harden_functions.sql
supabase/seed_weber.sql  The Weber Mortgage org and one staff user
```

Scripts run with `tsx`, read `.env.local` without overriding the shell, and never print a key or token.

## Acceptance test (from the brief)

- [ ] 1. Michael opens the link on his phone, sees the Weber Mortgage consent page, checks the
      box, and connects Rocket Mortgage in Plaid Link. Plaid handles login and 2FA; we never see them.
- [ ] 2. The dashboard shows his **interest rate, rate type, current balance, monthly payment
      and next due date**, labeled "From the servicer, through Plaid."
- [ ] 3. Rate, monthly payment and next due date **match his latest Rocket statement**.
- [ ] 4. The refinance comparison shows **new P&I, monthly savings and payback** with the rate
      and closing costs Michael enters; his rule decides Ready, Watch or Not yet.
- [ ] 5. `/dashboard` needs **email + TOTP two-factor**.
- [ ] 6. A Plaid `DEFAULT_UPDATE` webhook refreshes the loan automatically.

## Data minimization

Stored: borrower name and invite email; servicer name, connection status, last updated time;
rate and type, current balance, next monthly payment and due date, origination date, original
amount, loan term, maturity date, loan type; last 4 of the loan number; the encrypted access
token and item id. (Also Plaid's opaque `account_id`, used only to update the same loan on refresh.)

Never stored: passwords, 2FA codes, SSNs, transactions, full account numbers, escrow, PMI,
property address, past-due amounts, late fees. `src/lib/plaid-map.ts` builds a new object from
an allow-list, and tests check the dropped fields never come through. The database also refuses
plaintext tokens and account numbers longer than 4 characters.

## Compliance guardrails in the code

- Nothing goes to borrowers automatically. Invite links are created on the dashboard and sent by
  staff by hand. No texts, no credit pulls.
- Refinance numbers are staff-only. `BORROWER_REFI_VIEW` (default `false`) gates any borrower
  view; with it off, no borrower route computes or returns refinance numbers.
- Do not promise coverage for Mr. Cooper, Pennymac, Freedom or Shellpoint.

## The rule (ported from the demo)

- Current P&I: fixed rate uses the note (original amount, note rate, original term). ARM uses
  the balance at the note rate over the payments left. A fixed loan whose servicer doesn't
  report the original amount or term also uses the balance, and the drawer says so.
- Payments left: next due date to maturity date, both counted.
- New P&I: current balance at today's rate over the remaining term (default), or a new 30-year
  term; the other is shown separately in the detail panel.
- Savings: P&I only. Payback: closing costs / savings, rounded up.
- Default rule: 0.75 points lower, $150 a month, 36 months payback, 6 months since closing.
- Watch: exactly one money line misses, by no more than 0.25 points, $50 or 12 months.
- A missing field is shown as missing, never guessed, and blocks Ready.
- VA and FHA streamline starting points (from the demo) are in the preset menu.

Fonts: Inter (SIL Open Font License 1.1), the same files the demo embeds.
