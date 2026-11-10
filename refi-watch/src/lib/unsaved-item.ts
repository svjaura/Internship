/**
 * Recovery line for a Plaid connection the database could not save.
 *
 * A Trial plan has 10 connections and a removed one does not free its slot, so a borrower
 * must never have to connect twice because our database hiccuped. If the exchange route
 * still can't save the item after its retry, it writes ONE server log line:
 *
 *   REFIWATCH_UNSAVED_ITEM {"v":1,"item_id":...,"org_id":...,"borrower_id":...,
 *                           "institution_name":...,"access_token_enc":"v1....","at":...,"reason":...}
 *
 * access_token_enc is the token ALREADY encrypted with TOKEN_ENCRYPTION_KEY (AES-256-GCM,
 * bound to the item id), exactly what the database would have stored. The plaintext token is
 * never logged; the line is useless without the key. scripts/recover-item.ts reads the line
 * from the Vercel logs and inserts the item.
 */

export const UNSAVED_ITEM_TAG = "REFIWATCH_UNSAVED_ITEM";

export interface UnsavedItem {
  item_id: string;
  org_id: string;
  borrower_id: string;
  institution_name: string | null;
  access_token_enc: string;
  /** ISO time the save failed. */
  at: string;
  /** Short reason the save failed (database error message, no values). */
  reason?: string;
}

const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCRYPTED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class UnsavedItemLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsavedItemLineError";
  }
}

/** Throws unless every field has the right shape. Never echoes the token. */
export function validateUnsavedItem(x: unknown): UnsavedItem {
  if (!x || typeof x !== "object") throw new UnsavedItemLineError("not a JSON object");
  const o = x as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (!ITEM_ID.test(str("item_id"))) throw new UnsavedItemLineError("item_id is missing or malformed");
  if (!UUID.test(str("org_id"))) throw new UnsavedItemLineError("org_id is not a uuid");
  // The memory store (local test mode) uses non-uuid borrower ids; Postgres needs a uuid.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(str("borrower_id"))) throw new UnsavedItemLineError("borrower_id is missing or malformed");
  if (!ENCRYPTED.test(str("access_token_enc"))) throw new UnsavedItemLineError("access_token_enc is not an encrypted v1 token");
  const inst = o.institution_name;
  if (inst !== null && inst !== undefined && (typeof inst !== "string" || inst.length > 120)) throw new UnsavedItemLineError("institution_name is malformed");
  return {
    item_id: str("item_id"),
    org_id: str("org_id"),
    borrower_id: str("borrower_id"),
    institution_name: typeof inst === "string" ? inst : null,
    access_token_enc: str("access_token_enc"),
    at: str("at"),
    ...(str("reason") ? { reason: str("reason") } : {}),
  };
}

/**
 * The single log line. The one hard rule is here: it refuses a token that isn't encrypted.
 * Other fields are not validated on the way out, so an odd-looking id can never cost the line;
 * parseUnsavedItemLine() checks them on the way back in.
 */
export function formatUnsavedItemLine(i: UnsavedItem): string {
  if (typeof i.access_token_enc !== "string" || !ENCRYPTED.test(i.access_token_enc)) {
    throw new UnsavedItemLineError("refusing to log a token that is not encrypted");
  }
  const { item_id, org_id, borrower_id, institution_name, access_token_enc, at, reason } = i;
  return `${UNSAVED_ITEM_TAG} ${JSON.stringify({ v: 1, item_id, org_id, borrower_id, institution_name, access_token_enc, at, reason })}`;
}

/**
 * Reads the line back from whatever was copied out of the logs: the bare line, the line with a
 * timestamp in front, or a JSON log export where the quotes are escaped.
 */
export function parseUnsavedItemLine(text: string): UnsavedItem {
  const at = text.indexOf(UNSAVED_ITEM_TAG);
  if (at < 0) throw new UnsavedItemLineError(`no ${UNSAVED_ITEM_TAG} line found`);
  let rest = text.slice(at + UNSAVED_ITEM_TAG.length);
  const start = rest.indexOf("{");
  if (start < 0) throw new UnsavedItemLineError("no JSON after the tag");
  rest = rest.slice(start);
  const candidates = [rest, rest.replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
  for (const c of candidates) {
    const end = matchingBrace(c);
    if (end < 0) continue;
    try {
      return validateUnsavedItem(JSON.parse(c.slice(0, end + 1)));
    } catch (e) {
      if (e instanceof UnsavedItemLineError) throw e;
    }
  }
  throw new UnsavedItemLineError("the JSON after the tag is cut off or invalid; copy the whole line");
}

/** Index of the brace that closes the object starting at 0, ignoring braces inside strings. */
function matchingBrace(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}
