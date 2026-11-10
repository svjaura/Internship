/**
 * Check the env vars before go-live. Prints only names, PLAID_ENV and what's wrong; never a value.
 *
 *   npm run check-env                          checks the shell's variables plus .env.local
 *   npx tsx scripts/check-env.ts <file>        checks another env file, e.g. one from `vercel env pull`
 *
 * Exits 1 if anything needed to go live is missing or malformed. The same check runs on the
 * deployed app at GET /api/health.
 */
import { fail, prepareScriptEnv } from "./lib/script-env";
import { checkEnv } from "../src/lib/env-check";

const fileArg = process.argv[2];
if (fileArg?.startsWith("--")) fail(`unknown flag ${fileArg}. Usage: npx tsx scripts/check-env.ts [env-file]`);
const { envFile } = prepareScriptEnv({ envFile: fileArg });
if (fileArg && !envFile) fail(`${fileArg} not found`);

const report = checkEnv(process.env);
const tag = { ok: "OK  ", warn: "WARN", error: "FAIL" } as const;
console.log("Refi Watch: env check (values are never printed)");
console.log(`  env file: ${envFile ?? "none (using the shell's variables)"}`);
console.log(`  PLAID_ENV: ${report.plaidEnv}\n`);
const width = Math.max(...report.checks.map((c) => c.key.length));
for (const c of report.checks) console.log(`  ${tag[c.level]}  ${c.key.padEnd(width)}  ${c.message}`);

const errors = report.checks.filter((c) => c.level === "error").length;
const warns = report.checks.filter((c) => c.level === "warn").length;
console.log(`\n${errors ? `NOT READY: ${errors} problem${errors === 1 ? "" : "s"}` : "READY"}${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}.`);
if (errors) process.exit(1);
