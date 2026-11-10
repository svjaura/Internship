/**
 * Refresh one Plaid Item: /liabilities/get -> minimized fields -> loans table.
 * Called after a new connection and on LIABILITIES DEFAULT_UPDATE webhooks.
 */
import "server-only";
import { decryptToken } from "./crypto";
import { getStore, type StoredItem } from "./db";
import { describePlaidError, fetchMinimalLoans, plaidErrorCode } from "./plaid";

const RECONNECT_CODES = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS"]);

export type RefreshResult = { ok: true; loans: number } | { ok: false; code: string };

export async function refreshItem(itemOrId: StoredItem | string): Promise<RefreshResult> {
  const store = getStore();
  const item = typeof itemOrId === "string" ? await store.getItem(itemOrId) : itemOrId;
  if (!item) return { ok: false, code: "UNKNOWN_ITEM" };
  if (item.status === "revoked") return { ok: false, code: "REVOKED" };

  let accessToken: string;
  try {
    accessToken = decryptToken(item.accessTokenEnc, item.itemId);
  } catch {
    console.error(`refresh ${item.itemId}: could not decrypt the access token (check TOKEN_ENCRYPTION_KEY)`);
    await store.setItemStatus(item.itemId, "error", "TOKEN_DECRYPT_FAILED");
    return { ok: false, code: "TOKEN_DECRYPT_FAILED" };
  }

  try {
    const loans = await fetchMinimalLoans(accessToken, item.institutionName);
    await store.saveLoans(item, loans);
    await store.audit(item.orgId, null, "plaid_refresh", { item: item.itemId, loans: loans.length });
    return { ok: true, loans: loans.length };
  } catch (e) {
    const code = plaidErrorCode(e) || "REFRESH_FAILED";
    console.error(`refresh ${item.itemId}: ${describePlaidError(e)}`);
    if (RECONNECT_CODES.has(code)) {
      await store.setItemStatus(item.itemId, "login_required", code);
      await store.audit(item.orgId, null, "plaid_status", { item: item.itemId, status: "login_required", reason: code });
    }
    return { ok: false, code };
  }
}
