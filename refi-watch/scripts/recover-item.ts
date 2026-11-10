/**
 * Recover a Plaid connection that was made but not saved, from its log line.
 *
 * When does this happen? A borrower finished Plaid Link, but the database refused the save
 * twice. The exchange route then logged one line tagged REFIWATCH_UNSAVED_ITEM with the item id,
 * org id, borrower id and the access token ALREADY ENCRYPTED. The borrower was asked to call
 * instead of connecting again (a second connection would use another Trial slot).
 *
 * 1. Vercel > the project > Logs, search REFIWATCH_UNSAVED_ITEM, copy the whole line.
 * 2. Fix whatever broke the save (Supabase down, paused project, wrong key...).
 * 3. Check, then insert:
 *      npx tsx scripts/recover-item.ts --dry-run 'REFIWATCH_UNSAVED_ITEM {...}'
 *      npx tsx scripts/recover-item.ts 'REFIWATCH_UNSAVED_ITEM {...}'
 *    (or pipe the line in: pbpaste | npx tsx scripts/recover-item.ts)
 *
 * Needs, in the shell or in .env.local (values are never printed):
 *   TOKEN_ENCRYPTION_KEY         the SAME key the Vercel deployment uses
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   the live project
 *   PLAID_CLIENT_ID, PLAID_ENV=production, PLAID_SECRET_PRODUCTION   optional, to load the loan now
 * Flags: --dry-run (check only), --no-refresh (insert only; the next webhook loads the loan).
 */
import { fail, prepareScriptEnv } from "./lib/script-env";

const { envFile } = prepareScriptEnv();

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--dry-run" && f !== "--no-refresh") fail(`unknown flag ${f}. Use --dry-run or --no-refresh.`);
  const text = args.filter((a) => !a.startsWith("--")).join(" ") || (await readStdin());

  const { parseUnsavedItemLine, UnsavedItemLineError } = await import("../src/lib/unsaved-item");
  const { recoverUnsavedItem, RecoverError } = await import("../src/lib/recover-item");
  const { parseKey } = await import("../src/lib/crypto");

  console.log("Refi Watch: recover an unsaved Plaid item");
  console.log(`  env file: ${envFile ?? "none (using the shell's variables)"}`);
  if (!text.trim()) fail("paste the REFIWATCH_UNSAVED_ITEM line as an argument (in single quotes) or pipe it in.");
  try {
    parseKey(process.env.TOKEN_ENCRYPTION_KEY);
  } catch (e) {
    fail(`${e instanceof Error ? e.message : "TOKEN_ENCRYPTION_KEY is not usable"}. Use the same key as the Vercel deployment.`);
  }

  try {
    const line = parseUnsavedItemLine(text);
    console.log(`  item ${line.item_id}, org ${line.org_id}, borrower ${line.borrower_id}, ${line.institution_name ?? "institution not reported"}`);
    if (line.at) console.log(`  save failed at ${line.at}${line.reason ? `: ${line.reason}` : ""}`);
    const res = await recoverUnsavedItem(line, {
      dryRun: flags.has("--dry-run"),
      refresh: !flags.has("--no-refresh"),
      log: (l) => console.log(`  ${l}`),
    });
    console.log(`\n${res.status === "dry_run" ? "DRY RUN OK: nothing written. Run again without --dry-run to insert." : res.status === "inserted" ? "RECOVERED. Check the dashboard." : "NOTHING TO DO: the item is already saved."}`);
  } catch (e) {
    if (e instanceof UnsavedItemLineError) fail(`that doesn't look like a whole REFIWATCH_UNSAVED_ITEM line: ${e.message}.`);
    if (e instanceof RecoverError) fail(e.message);
    fail(e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "unknown error");
  }
}

void main();
