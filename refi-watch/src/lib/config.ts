/**
 * Environment and mode. Server only (reads secrets).
 *
 * Modes:
 * - Live: Supabase keys are set. Staff log in with email + TOTP. Data in Postgres.
 * - No-keys (local test mode): Supabase keys are missing. The dashboard serves the
 *   demo's 13 test loans from memory, staff login is bypassed and a banner says so.
 *   Refused on a Vercel production deployment, so a missing env var can never
 *   open the dashboard in production.
 */
import "server-only";

export type PlaidEnv = "sandbox" | "production";

const val = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export function plaidEnv(): PlaidEnv {
  return val("PLAID_ENV") === "production" ? "production" : "sandbox";
}

/** The Plaid secret for the current PLAID_ENV. PLAID_SECRET overrides both. */
export function plaidSecret(): string | undefined {
  return val("PLAID_SECRET") ?? (plaidEnv() === "production" ? val("PLAID_SECRET_PRODUCTION") : val("PLAID_SECRET_SANDBOX"));
}

export function plaidConfigured(): boolean {
  return Boolean(val("PLAID_CLIENT_ID") && plaidSecret());
}

export function supabaseConfigured(): boolean {
  return Boolean(val("SUPABASE_URL") && val("SUPABASE_ANON_KEY") && val("SUPABASE_SERVICE_ROLE_KEY"));
}

export function supabasePublic(): { url: string; anonKey: string } | null {
  const url = val("SUPABASE_URL");
  const anonKey = val("SUPABASE_ANON_KEY");
  return url && anonKey ? { url, anonKey } : null;
}

/** True on a Vercel production deployment. */
export function isVercelProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** No-keys mode: no Supabase, so demo data from memory and no staff login. */
export function isNoKeysMode(): boolean {
  return !supabaseConfigured();
}

/** No-keys mode is allowed only off Vercel production. */
export function noKeysModeAllowed(): boolean {
  return isNoKeysMode() && !isVercelProduction();
}

/**
 * Borrower-facing refinance numbers are rate advertising. Off until Michael
 * approves the wording and disclosures. Only the exact string "true" turns it on.
 */
export function borrowerRefiViewEnabled(): boolean {
  return val("BORROWER_REFI_VIEW") === "true";
}

export function plaidWebhookUrl(): string | undefined {
  return val("PLAID_WEBHOOK_URL");
}

/** Optional. Needed for OAuth banks (Chase, Wells Fargo, Bank of America) in a phone browser. */
export function plaidRedirectUri(): string | undefined {
  return val("PLAID_REDIRECT_URI");
}

/** Optional link to Weber Mortgage's privacy notice, shown on the consent page. */
export function privacyNoticeUrl(): string | null {
  const u = val("PRIVACY_NOTICE_URL");
  return u && /^https:\/\//.test(u) ? u : null;
}

export const ORG_DISPLAY = {
  name: "Weber Mortgage",
  legal: "Bud Weber Mortgages LLC, NMLS 219938. Michael Weber, NMLS 219982. Equal Housing Opportunity.",
  contact: "Michael Weber",
  contactFirstName: "Michael",
  phone: "(205) 823-6701",
  timeZone: "America/Chicago",
} as const;
