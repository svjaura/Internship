/**
 * Put a Plaid item back in the database from its REFIWATCH_UNSAVED_ITEM log line.
 * Used by scripts/recover-item.ts. See src/lib/unsaved-item.ts for the line.
 *
 * 1. Checks the encrypted token decrypts with this TOKEN_ENCRYPTION_KEY and the item id
 *    (right key, intact line). The plaintext is never printed or kept.
 * 2. Inserts the item exactly as the exchange route would have (the token stays encrypted).
 * 3. Optionally runs the first /liabilities/get, so the loan shows on the dashboard.
 */
import "server-only";
import { plaidConfigured, plaidEnv } from "./config";
import { decryptToken } from "./crypto";
import { getStore, type Store } from "./db";
import { refreshItem, type RefreshResult } from "./refresh";
import type { UnsavedItem } from "./unsaved-item";

export class RecoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverError";
  }
}

export interface RecoverOptions {
  /** Check only; write nothing. */
  dryRun?: boolean;
  /** Run the first /liabilities/get after inserting (default true, when Plaid keys for the token's environment are set). */
  refresh?: boolean;
  /** Tests only: the store to write to. Defaults to the app's store, which must be Supabase. */
  store?: Store;
  log?: (line: string) => void;
}

export interface RecoverResult {
  status: "dry_run" | "inserted" | "already_saved";
  itemId: string;
  /** sandbox or production, from the token's own prefix. */
  tokenEnv: "sandbox" | "production" | "unknown";
  refresh: RefreshResult | "skipped";
}

export async function recoverUnsavedItem(u: UnsavedItem, opts: RecoverOptions = {}): Promise<RecoverResult> {
  const log = opts.log ?? (() => {});

  let tokenEnv: RecoverResult["tokenEnv"];
  try {
    const plain = decryptToken(u.access_token_enc, u.item_id);
    tokenEnv = plain.startsWith("access-production-") ? "production" : plain.startsWith("access-sandbox-") ? "sandbox" : "unknown";
  } catch {
    throw new RecoverError(
      "The token does not decrypt with this TOKEN_ENCRYPTION_KEY and item id. Use the exact key the Vercel deployment had when it wrote the line, and copy the whole line.",
    );
  }
  log(`Token decrypts with this key (a ${tokenEnv} token). It stays encrypted in the database.`);

  const store = opts.store ?? getStore();
  if (!opts.store && store.kind !== "supabase") {
    throw new RecoverError("Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for the live project.");
  }

  const existing = await store.getItem(u.item_id);
  if (existing) {
    log(`Item ${u.item_id} is already in the database (status ${existing.status}). Nothing to insert.`);
    return { status: "already_saved", itemId: u.item_id, tokenEnv, refresh: "skipped" };
  }
  if (opts.dryRun) {
    log(`Dry run: would insert item ${u.item_id} for org ${u.org_id}, borrower ${u.borrower_id}.`);
    return { status: "dry_run", itemId: u.item_id, tokenEnv, refresh: "skipped" };
  }

  const item = await store
    .saveItem({ orgId: u.org_id, borrowerId: u.borrower_id, itemId: u.item_id, accessTokenEnc: u.access_token_enc, institutionName: u.institution_name })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : "insert failed";
      const hint = /plaid_items_one_per_borrower/.test(msg)
        ? " This borrower already has a live connection; look at it on the dashboard before changing anything."
        : /foreign key/i.test(msg)
          ? " The org or borrower id is not in this database: is this the right Supabase project?"
          : "";
      throw new RecoverError(`Insert failed: ${msg.slice(0, 200)}.${hint}`);
    });
  await store.audit(u.org_id, null, "plaid_connected", { item: u.item_id, institution: u.institution_name, recovered: true });
  log(`Inserted item ${u.item_id}.`);

  let refresh: RecoverResult["refresh"] = "skipped";
  if (opts.refresh === false) {
    log("Skipped the first /liabilities/get (--no-refresh). The next DEFAULT_UPDATE webhook will load the loan.");
  } else if (!plaidConfigured() || (tokenEnv !== "unknown" && tokenEnv !== plaidEnv())) {
    log(`Skipped the first /liabilities/get: set PLAID_CLIENT_ID, PLAID_ENV=${tokenEnv} and its secret to run it. The next DEFAULT_UPDATE webhook will load the loan.`);
  } else {
    refresh = await refreshItem(item);
    log(refresh.ok ? `Loaded ${refresh.loans} loan(s) from /liabilities/get.` : `First /liabilities/get failed (${refresh.code}). The item is saved; the next webhook will retry.`);
  }
  return { status: "inserted", itemId: u.item_id, tokenEnv, refresh };
}
