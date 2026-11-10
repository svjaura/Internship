/**
 * Setup check for the env vars Refi Watch needs to go live. Pure: pass it an env object.
 * Used by GET /api/health and scripts/check-env.ts.
 *
 * Never returns a value: only whether each variable is present, PLAID_ENV (not a secret),
 * and fixed messages that name the variable and what is wrong with it.
 */
import { parseKey } from "./crypto";

export type Level = "ok" | "warn" | "error";
export interface EnvCheck {
  key: string;
  level: Level;
  message: string;
}

export const ENV_VARS = [
  "PLAID_CLIENT_ID",
  "PLAID_SECRET_SANDBOX",
  "PLAID_SECRET_PRODUCTION",
  "PLAID_SECRET",
  "PLAID_ENV",
  "PLAID_WEBHOOK_URL",
  "PLAID_REDIRECT_URI",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "BORROWER_REFI_VIEW",
  "PRIVACY_NOTICE_URL",
] as const;
export type EnvVar = (typeof ENV_VARS)[number];

/** Needed to go live. The Plaid secret for PLAID_ENV is checked separately. */
export const REQUIRED_VARS: ReadonlyArray<EnvVar> = [
  "PLAID_CLIENT_ID",
  "PLAID_ENV",
  "PLAID_WEBHOOK_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TOKEN_ENCRYPTION_KEY",
];

export const WEBHOOK_PATH = "/api/plaid/webhook";
export const OAUTH_PATH = "/connect/oauth";

export interface EnvReport {
  /** No errors: everything needed to go live is set and looks right. */
  ok: boolean;
  plaidEnv: "sandbox" | "production" | "invalid" | "unset";
  present: Record<EnvVar, boolean>;
  checks: EnvCheck[];
}

type Env = Record<string, string | undefined>;

function httpsUrl(v: string): URL | null {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") ? u : null;
  } catch {
    return null;
  }
}

/** The role inside a legacy Supabase JWT key (anon or service_role), or null. Reads the claim only. */
function jwtRole(v: string): string | null {
  const parts = v.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}
const isPublicSupabaseKey = (v: string) => v.startsWith("sb_publishable_") || jwtRole(v) === "anon";
const isSecretSupabaseKey = (v: string) => v.startsWith("sb_secret_") || jwtRole(v) === "service_role";

export function checkEnv(env: Env): EnvReport {
  const get = (k: EnvVar): string => (env[k] ?? "").trim();
  const present = Object.fromEntries(ENV_VARS.map((k) => [k, get(k) !== ""])) as Record<EnvVar, boolean>;
  const checks: EnvCheck[] = [];
  const add = (key: string, level: Level, message: string) => checks.push({ key, level, message });

  for (const k of REQUIRED_VARS) if (!present[k]) add(k, "error", "not set");

  // Plaid
  const rawEnv = get("PLAID_ENV");
  const plaidEnv: EnvReport["plaidEnv"] = !rawEnv ? "unset" : rawEnv === "sandbox" || rawEnv === "production" ? rawEnv : "invalid";
  if (plaidEnv === "invalid") add("PLAID_ENV", "error", 'must be exactly "sandbox" or "production" (anything else runs as sandbox)');
  else if (plaidEnv !== "unset") add("PLAID_ENV", "ok", plaidEnv);
  if (present.PLAID_CLIENT_ID) add("PLAID_CLIENT_ID", "ok", "set");

  if (present.PLAID_SECRET) {
    add("PLAID_SECRET", "warn", "overrides both per-environment secrets, so switching PLAID_ENV won't switch the secret; prefer PLAID_SECRET_SANDBOX and PLAID_SECRET_PRODUCTION");
  }
  if (plaidEnv === "sandbox" || plaidEnv === "production") {
    const forEnv: EnvVar = plaidEnv === "production" ? "PLAID_SECRET_PRODUCTION" : "PLAID_SECRET_SANDBOX";
    const other: EnvVar = plaidEnv === "production" ? "PLAID_SECRET_SANDBOX" : "PLAID_SECRET_PRODUCTION";
    if (present[forEnv] || present.PLAID_SECRET) add(forEnv, "ok", `set (used while PLAID_ENV=${plaidEnv})`);
    else add(forEnv, "error", `not set: it's the secret used while PLAID_ENV=${plaidEnv}`);
    if (!present[other] && !present.PLAID_SECRET) add(other, "warn", `not set: needed when PLAID_ENV switches to ${plaidEnv === "sandbox" ? "production" : "sandbox"}`);
  }
  if (present.PLAID_SECRET_SANDBOX && get("PLAID_SECRET_SANDBOX") === get("PLAID_SECRET_PRODUCTION")) {
    add("PLAID_SECRET_PRODUCTION", "error", "is the same as PLAID_SECRET_SANDBOX; copy each one from its own row in the Plaid dashboard");
  }

  // URLs
  if (present.PLAID_WEBHOOK_URL) {
    const u = httpsUrl(get("PLAID_WEBHOOK_URL"));
    if (!u) add("PLAID_WEBHOOK_URL", "error", "must be an https URL, like https://<your-domain>/api/plaid/webhook");
    else if (u.pathname !== WEBHOOK_PATH || u.search || u.hash) add("PLAID_WEBHOOK_URL", "error", `must end with ${WEBHOOK_PATH} (no trailing slash or query)`);
    else if (/^(localhost|127\.)/.test(u.hostname)) add("PLAID_WEBHOOK_URL", "error", "must be the public Vercel domain, not localhost");
    else if (u.hostname.includes("-git-")) add("PLAID_WEBHOOK_URL", "warn", "looks like a preview deployment URL; use the production domain so Plaid isn't blocked by preview protection");
    else add("PLAID_WEBHOOK_URL", "ok", "https, ends with /api/plaid/webhook");
  }
  if (present.PLAID_REDIRECT_URI) {
    const u = httpsUrl(get("PLAID_REDIRECT_URI"));
    if (!u || u.pathname !== OAUTH_PATH) add("PLAID_REDIRECT_URI", "error", `must be https://<your-domain>${OAUTH_PATH}, and the same URI must be in Plaid's Allowed redirect URIs`);
    else if (present.PLAID_WEBHOOK_URL && httpsUrl(get("PLAID_WEBHOOK_URL"))?.host !== u.host) add("PLAID_REDIRECT_URI", "warn", "is on a different domain than PLAID_WEBHOOK_URL");
    else add("PLAID_REDIRECT_URI", "ok", "https, ends with /connect/oauth");
  }
  if (present.SUPABASE_URL) {
    const u = httpsUrl(get("SUPABASE_URL"));
    if (!u) add("SUPABASE_URL", "error", "must be an https URL, like https://<project-ref>.supabase.co");
    else if (u.pathname !== "/" || u.search) add("SUPABASE_URL", "error", "must be the project URL only, without /rest/v1 or any path");
    else if (!u.hostname.endsWith(".supabase.co")) add("SUPABASE_URL", "warn", "is not a *.supabase.co URL (fine only for a custom domain)");
    else add("SUPABASE_URL", "ok", "https project URL");
  }
  if (present.PRIVACY_NOTICE_URL && !httpsUrl(get("PRIVACY_NOTICE_URL"))) add("PRIVACY_NOTICE_URL", "warn", "is not an https URL, so the consent page won't show it");

  // Supabase keys: the anon/publishable key is sent to the browser, so it must never be a secret key.
  const anon = get("SUPABASE_ANON_KEY");
  const service = get("SUPABASE_SERVICE_ROLE_KEY");
  if (anon) {
    if (isSecretSupabaseKey(anon)) add("SUPABASE_ANON_KEY", "error", "is a secret (service role) key; it's sent to the browser, so use the publishable (anon) key here");
    else add("SUPABASE_ANON_KEY", "ok", isPublicSupabaseKey(anon) ? "public key" : "set");
  }
  if (service) {
    if (service === anon) add("SUPABASE_SERVICE_ROLE_KEY", "error", "is the same as SUPABASE_ANON_KEY; use the secret (service role) key");
    else if (isPublicSupabaseKey(service)) add("SUPABASE_SERVICE_ROLE_KEY", "error", "is the public (anon) key; use the secret (service role) key");
    else add("SUPABASE_SERVICE_ROLE_KEY", "ok", isSecretSupabaseKey(service) ? "secret key" : "set");
  }

  // Token encryption
  if (present.TOKEN_ENCRYPTION_KEY) {
    try {
      parseKey(get("TOKEN_ENCRYPTION_KEY"));
      add("TOKEN_ENCRYPTION_KEY", "ok", "decodes to 32 bytes");
    } catch (e) {
      // parseKey's messages name the variable and the decoded length, never the key.
      const why = e instanceof Error ? e.message.replace(/^TOKEN_ENCRYPTION_KEY /, "") : "is not usable";
      const hex = /^[0-9a-f]{64}$/i.test(get("TOKEN_ENCRYPTION_KEY")) ? " It looks like hex:" : "";
      add("TOKEN_ENCRYPTION_KEY", "error", `${why}.${hex} Generate one with: openssl rand -base64 32`);
    }
  }

  // Compliance switch
  if (get("BORROWER_REFI_VIEW") === "true") add("BORROWER_REFI_VIEW", "warn", "is ON: borrowers would see refinance numbers. Keep it false until Michael approves the wording.");
  else add("BORROWER_REFI_VIEW", "ok", "off");

  return { ok: !checks.some((c) => c.level === "error"), plaidEnv, present, checks };
}
