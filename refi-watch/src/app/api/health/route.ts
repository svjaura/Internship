/**
 * GET /api/health  Setup check for go-live. Public, read-only, no network calls.
 *
 * Returns which env vars are present (booleans only), PLAID_ENV, the mode, and fixed
 * messages naming any variable that is missing or malformed. Never a value, never a secret.
 * 200 when everything needed to go live is set and looks right, 503 otherwise.
 * Supabase and Plaid reachability are not checked here.
 */
import { supabaseConfigured } from "@/lib/config";
import { checkEnv } from "@/lib/env-check";

// Read the env at request time, never at build time.
export const dynamic = "force-dynamic";

export function GET() {
  const report = checkEnv(process.env);
  const body = {
    ok: report.ok,
    plaid_env: report.plaidEnv,
    mode: supabaseConfigured() ? "live" : "local-test",
    env: report.present,
    problems: report.checks.filter((c) => c.level === "error").map((c) => `${c.key}: ${c.message}`),
    warnings: report.checks.filter((c) => c.level === "warn").map((c) => `${c.key}: ${c.message}`),
    deployment: {
      vercel_env: process.env.VERCEL_ENV ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
    },
  };
  return Response.json(body, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
