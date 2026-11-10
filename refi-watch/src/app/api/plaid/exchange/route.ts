/**
 * POST /api/plaid/exchange  { invite, public_token, institution_name? }
 *
 * New connection: public_token -> access_token (encrypted with AES-256-GCM,
 * bound to the item_id) + item_id, then a first /liabilities/get.
 * Update mode (reconnect): the access token does not change, so nothing is
 * exchanged; the status goes back to ok and the loan is refreshed.
 *
 * If the item can't be saved even after a retry, the encrypted token goes to the server log as one
 * REFIWATCH_UNSAVED_ITEM line (see src/lib/unsaved-item.ts) and the borrower is asked to call
 * rather than connect again: a second connection would use another Trial slot.
 *
 * The response to the borrower never carries refinance numbers.
 */
import { plaidConfigured, plaidEnv, supabaseConfigured } from "@/lib/config";
import { encryptToken, parseKey } from "@/lib/crypto";
import { getStore, type StoredItem } from "@/lib/db";
import { describePlaidError, exchangePublicToken } from "@/lib/plaid";
import { refreshItem } from "@/lib/refresh";
import { formatUnsavedItemLine } from "@/lib/unsaved-item";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { invite?: unknown; public_token?: unknown; institution_name?: unknown } | null;
  const code = typeof body?.invite === "string" ? body.invite : "";
  const publicToken = typeof body?.public_token === "string" ? body.public_token : "";
  const institutionName = typeof body?.institution_name === "string" ? body.institution_name.slice(0, 120) : null;

  const store = getStore();
  const invite = await store.getInvite(code);
  if (!invite) return Response.json({ error: "invite_not_found" }, { status: 404 });
  if (!plaidConfigured()) return Response.json({ error: "plaid_not_configured" }, { status: 400 });
  if (plaidEnv() === "production" && !supabaseConfigured()) return Response.json({ error: "storage_not_configured" }, { status: 503 });
  // Check the encryption key before Plaid creates anything: a token we cannot store would waste a connection.
  try {
    parseKey(process.env.TOKEN_ENCRYPTION_KEY);
  } catch {
    console.error("TOKEN_ENCRYPTION_KEY is missing or not 32 bytes of base64");
    return Response.json({ error: "encryption_not_configured" }, { status: 503 });
  }

  // Reconnect through update mode: same Item, same token.
  if (invite.state === "reconnect" && invite.item) {
    await store.setItemStatus(invite.item.itemId, "ok", null);
    const r = await refreshItem({ ...invite.item, status: "ok" });
    await store.audit(invite.orgId, null, "plaid_status", { item: invite.item.itemId, status: "ok", reason: "reconnected" });
    return Response.json({ ok: true, firstName: invite.firstName, refreshed: r.ok });
  }
  if (invite.state === "connected") return Response.json({ error: "already_connected" }, { status: 409 });
  if (!publicToken) return Response.json({ error: "public_token_required" }, { status: 400 });

  try {
    const ex = await exchangePublicToken(publicToken);
    const toSave = {
      orgId: invite.orgId,
      borrowerId: invite.borrowerId,
      itemId: ex.itemId,
      accessTokenEnc: encryptToken(ex.accessToken, ex.itemId),
      institutionName,
    };
    // One retry: losing the token here would waste a Trial connection slot.
    let item: StoredItem;
    try {
      item = await store.saveItem(toSave).catch(async (e) => {
        console.error(`exchange: first save of item ${ex.itemId} failed, retrying:`, e instanceof Error ? e.message : "error");
        return store.saveItem(toSave);
      });
    } catch (e) {
      // Still not saved. One log line with the token ALREADY ENCRYPTED (never plaintext), so the item can be
      // recovered from the Vercel logs with scripts/recover-item.ts instead of the borrower connecting again.
      console.error(
        formatUnsavedItemLine({
          item_id: toSave.itemId,
          org_id: toSave.orgId,
          borrower_id: toSave.borrowerId,
          institution_name: toSave.institutionName,
          access_token_enc: toSave.accessTokenEnc,
          at: new Date().toISOString(),
          reason: (e instanceof Error ? e.message : "save failed").slice(0, 200),
        }),
      );
      return Response.json({ error: "save_failed" }, { status: 500 });
    }
    await store.audit(invite.orgId, null, "plaid_connected", { item: ex.itemId, institution: institutionName });
    const r = await refreshItem(item);
    return Response.json({ ok: true, firstName: invite.firstName, refreshed: r.ok });
  } catch (e) {
    console.error("exchange:", describePlaidError(e));
    return Response.json({ error: "exchange_failed" }, { status: 502 });
  }
}
