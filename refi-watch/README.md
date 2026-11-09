# Refi Watch (Weber Mortgage)

A working model of Refi Watch: a borrower connects their mortgage through Plaid (Liabilities),
the staff dashboard shows the servicer's real numbers, and Michael's rule decides
**Ready**, **Watch**, **Not yet** or **Reconnect**. Due Friday, Nov 20, 2026.

Stack: Next.js 16 (App Router, TypeScript) on Vercel, Supabase (Postgres + Auth with TOTP
two-factor), Plaid Node SDK (`plaid` v51), `react-plaid-link`.

## Run it locally (no keys needed)

```bash
npm install
npm run dev          # http://localhost:3000/dashboard
npm test             # vitest: rule engine, crypto, Plaid mapping, webhook, end-to-end flow
npm run typecheck    # tsc --noEmit
npm run lint
npm run build
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
| `POST /api/plaid/exchange` | `public_token` to `access_token`, encrypted (AES-256-GCM) with the `item_id`, then the first `/liabilities/get`. |
| `POST /api/plaid/webhook` | Verifies the `Plaid-Verification` JWT, then refreshes (LIABILITIES `DEFAULT_UPDATE`) or flags Reconnect (ITEM `ERROR` `ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`). |
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
src/proxy.ts             Next 16 "proxy" (was middleware): /dashboard requires aal2
supabase/migrations/0001_init.sql   Schema, org_id everywhere, RLS with org membership + aal2
```

## Go live: setup steps

### 1. Plaid (Weber Mortgage's own account)

1. Michael opens a Plaid account on the free **Trial** plan and adds Sai as a team member.
   **Never apply for Production access**: that ends the free Trial (10 real connections,
   Liabilities included). A removed connection does not free its slot.
2. Copy the client ID and both secrets (Sandbox and Production) into Vercel env vars
   (step 3). Do not paste them anywhere else.
3. Optional, for OAuth banks on phones: add `https://<domain>/connect/oauth` under
   *Team settings > API > Allowed redirect URIs*, and set `PLAID_REDIRECT_URI` to the same value.

### 2. Supabase (US region)

1. Create a project in a US region.
2. Run the migration: SQL editor, paste `supabase/migrations/0001_init.sql`, run.
   (Or `supabase db push` with the Supabase CLI.)
3. Auth settings: keep email sign-ups **off** (staff are added by hand). Turn on
   **Multi-Factor Authentication > TOTP**.
4. Create the staff user: *Authentication > Users > Add user* (email + password, auto-confirm).
5. Create the org and make the user a staff member (SQL editor):

   ```sql
   insert into public.orgs (name) values ('Weber Mortgage');
   insert into public.staff_members (org_id, user_id, role)
   select o.id, u.id, 'owner' from public.orgs o, auth.users u
   where o.name = 'Weber Mortgage' and u.email = 'michael@webermortgage.com';
   ```

   The org's default rule (6.125%, $4,000, 0.75 / $150 / 36 months / 6 months) is created
   automatically.

### 3. Vercel (US)

1. Import the repo, set the root directory to `refi-watch`.
2. Add env vars from `.env.example` (Production and Preview):
   `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX`, `PLAID_SECRET_PRODUCTION`, `PLAID_ENV`,
   `PLAID_WEBHOOK_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), `BORROWER_REFI_VIEW=false`.
   Keep a copy of `TOKEN_ENCRYPTION_KEY` in a password manager: without it, stored tokens are useless.
3. Set the function region to a US region (default `iad1` is fine).
4. Deploy. Set `PLAID_WEBHOOK_URL=https://<domain>/api/plaid/webhook` and redeploy.

### 4. Build order

1. `PLAID_ENV=sandbox`. Log in to `/dashboard`, create an invite for a test borrower, open the
   link, connect with Plaid's sandbox user (`user_good` / `pass_good`). The sandbox mortgage
   has old dates, so its payments-left math is not meaningful; it proves the wiring.
2. Test the webhook from sandbox: `POST https://sandbox.plaid.com/sandbox/item/fire_webhook`
   with `{"client_id","secret","access_token","webhook_type":"LIABILITIES","webhook_code":"DEFAULT_UPDATE"}`
   (needs the access token, so run it from a one-off server script, never from a browser),
   or `ITEM` / `ERROR` to see Reconnect.
3. Switch to `PLAID_ENV=production` (the Trial keys), redeploy, create Michael's invite, and
   text him the link yourself. Check the numbers against his latest Rocket statement.

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
  the balance at the note rate over the payments left.
- Payments left: next due date to maturity date, both counted.
- New P&I: current balance at today's rate over the remaining term (default), or a new 30-year
  term; the other is shown separately in the detail panel.
- Savings: P&I only. Payback: closing costs / savings, rounded up.
- Default rule: 0.75 points lower, $150 a month, 36 months payback, 6 months since closing.
- Watch: exactly one money line misses, by no more than 0.25 points, $50 or 12 months.
- A missing field is shown as missing, never guessed, and blocks Ready.
- VA and FHA streamline starting points (from the demo) are in the preset menu.

Fonts: Inter (SIL Open Font License 1.1), the same files the demo embeds.
