/**
 * POST /api/plaid/webhook
 *
 * Verifies the Plaid-Verification JWT (ES256, key from /webhook_verification_key/get,
 * at most 5 minutes old, SHA-256 of the raw body must match), then:
 *   LIABILITIES / DEFAULT_UPDATE              -> refresh the loan and recheck the rule
 *   ITEM / ERROR (ITEM_LOGIN_REQUIRED)         -> status Reconnect
 *   ITEM / PENDING_EXPIRATION (or _DISCONNECT) -> status Reconnect
 *   ITEM / LOGIN_REPAIRED                      -> status ok and refresh
 *   ITEM / USER_PERMISSION_REVOKED             -> revoked (hidden from the dashboard)
 * Answers fast; the refresh runs after the response.
 */
import { after } from "next/server";
import { plaidConfigured } from "@/lib/config";
import { getStore } from "@/lib/db";
import { getWebhookKey } from "@/lib/plaid";
import { verifyPlaidWebhook, webhookAction } from "@/lib/plaid-webhook";
import { refreshItem } from "@/lib/refresh";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!plaidConfigured()) return Response.json({ error: "plaid_not_configured" }, { status: 503 });

  const raw = await request.text();
  const verified = await verifyPlaidWebhook(raw, request.headers.get("plaid-verification"), getWebhookKey);
  if (!verified.ok) {
    console.warn("plaid webhook rejected:", verified.reason);
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const action = webhookAction(body);
  if (action.kind === "ignore") return Response.json({ received: true });

  const store = getStore();
  const item = await store.getItem(action.itemId);
  if (!item) {
    console.warn("plaid webhook for an unknown item");
    return Response.json({ received: true });
  }

  switch (action.kind) {
    case "refresh":
      after(() => refreshItem(item.itemId).then(() => undefined));
      break;
    case "reconnect": {
      const status = action.reason === "ITEM_LOGIN_REQUIRED" ? "login_required" : "pending_expiration";
      await store.setItemStatus(item.itemId, status, action.reason);
      await store.audit(item.orgId, null, "plaid_status", { item: item.itemId, status, reason: action.reason });
      break;
    }
    case "repaired":
      await store.setItemStatus(item.itemId, "ok", null);
      await store.audit(item.orgId, null, "plaid_status", { item: item.itemId, status: "ok", reason: "LOGIN_REPAIRED" });
      after(() => refreshItem(item.itemId).then(() => undefined));
      break;
    case "revoked":
      await store.setItemStatus(item.itemId, "revoked", "USER_PERMISSION_REVOKED");
      await store.audit(item.orgId, null, "plaid_status", { item: item.itemId, status: "revoked" });
      break;
  }
  return Response.json({ received: true });
}
