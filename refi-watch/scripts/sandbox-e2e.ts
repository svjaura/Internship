/**
 * Plaid Sandbox end-to-end check, no browser needed.
 *
 *   npm run sandbox:e2e        (or: npx tsx scripts/sandbox-e2e.ts)
 *
 * Needs, in the shell or in .env.local:
 *   PLAID_CLIENT_ID, and PLAID_SECRET_SANDBOX (or PLAID_SECRET set to the Sandbox secret)
 * Optional:
 *   PLAID_ENV                     must be "sandbox" or unset
 *   PLAID_WEBHOOK_URL             if set, the sandbox item gets this webhook and a
 *                                 LIABILITIES DEFAULT_UPDATE is fired at it
 *   PLAID_SANDBOX_INSTITUTION_ID  default ins_109508 (First Platypus Bank)
 *   TOKEN_ENCRYPTION_KEY          used if set (and so checked); otherwise a throwaway key
 *
 * Creates a sandbox Item (free, unlimited in Sandbox; never a Trial slot), exchanges it through
 * the app's own POST /api/plaid/exchange handler, fetches and maps /liabilities/get with the
 * app's refresh code, runs the rule, and prints a summary. Never writes to Supabase and never
 * prints a token or a key.
 */
import { randomBytes } from "node:crypto";
import { fail, prepareScriptEnv } from "./lib/script-env";

const { envFile } = prepareScriptEnv();

// Never touch the live database from a sandbox run: the app falls back to its in-memory store.
for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];
if (!process.env.PLAID_ENV?.trim()) process.env.PLAID_ENV = "sandbox";
let throwawayKey = false;
if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  throwawayKey = true;
}

async function main() {
  const { plaidConfigured } = await import("../src/lib/config");
  const { formatLoanSummary, runSandboxE2E, SandboxRunError } = await import("../src/lib/sandbox-e2e");

  console.log("Refi Watch: Plaid Sandbox end-to-end check");
  console.log(`  env file: ${envFile ?? "none (using the shell's variables)"}`);
  if (process.env.PLAID_ENV !== "sandbox") fail(`PLAID_ENV is "${process.env.PLAID_ENV}". Run with PLAID_ENV=sandbox.`);
  if (!plaidConfigured()) fail("Set PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX (or PLAID_SECRET) to the Sandbox keys.");
  if (throwawayKey) console.log("  TOKEN_ENCRYPTION_KEY not set: using a throwaway key for this run.");
  console.log("  storage: in memory (this run never writes to Supabase)\n");

  try {
    const result = await runSandboxE2E({
      institutionId: process.env.PLAID_SANDBOX_INSTITUTION_ID?.trim() || undefined,
      log: (line) => console.log(line),
    });
    for (const loan of result.loans) {
      console.log("");
      for (const line of formatLoanSummary(loan, result.settings, result.asOf)) console.log(line);
    }
    console.log("");
    if (result.webhook.fired) {
      console.log("Webhook: Plaid is sending LIABILITIES DEFAULT_UPDATE to the deployed app now. In Vercel > Logs:");
      console.log('  "plaid webhook for an unknown item"  = delivered and the signature verified (expected: this');
      console.log("                                         sandbox item lives only in this script's memory).");
      console.log('  "plaid webhook rejected: ..."        = signature check failed. Is the deployed PLAID_ENV sandbox?');
      console.log("  nothing within a minute               = check PLAID_WEBHOOK_URL and that the deployment is live.");
    }
    console.log("Sandbox numbers use Plaid's test mortgage (old dates), so the refinance math only proves the wiring.");
    if (!result.webhookRefresh.ok) fail(`the DEFAULT_UPDATE refresh failed (${result.webhookRefresh.code}).`);
    console.log("\nPASSED");
  } catch (e) {
    if (e instanceof SandboxRunError) fail(e.message);
    fail(e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "unknown error");
  }
}

void main();
