/**
 * POST /api/plaid/link-token  { invite, consent: true }
 *
 * New borrower: a Link token for Liabilities, mortgage accounts only.
 * Borrower whose connection needs a new login: a Link token in update mode
 * (same Item, so no duplicate connection and no extra Trial slot).
 * Borrower already connected: 409, so nobody creates a second connection.
 * No Plaid keys: { testMode: true } and the page simulates the connection.
 */
import { plaidConfigured, plaidEnv, supabaseConfigured } from "@/lib/config";
import { decryptToken, parseKey } from "@/lib/crypto";
import { getStore } from "@/lib/db";
import { createLinkToken, describePlaidError } from "@/lib/plaid";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { invite?: unknown; consent?: unknown } | null;
  const code = typeof body?.invite === "string" ? body.invite : "";
  if (body?.consent !== true) return Response.json({ error: "consent_required" }, { status: 400 });

  const store = getStore();
  const invite = await store.getInvite(code);
  if (!invite) return Response.json({ error: "invite_not_found" }, { status: 404 });
  if (invite.state === "connected") return Response.json({ error: "already_connected" }, { status: 409 });

  await store.recordConsent(invite.borrowerId);

  if (!plaidConfigured()) return Response.json({ testMode: true });

  // Without durable storage a real connection would be lost on restart and cost a Trial slot.
  if (plaidEnv() === "production" && !supabaseConfigured()) {
    return Response.json({ error: "storage_not_configured" }, { status: 503 });
  }
  // Check the encryption key before Plaid creates anything: a token we cannot store would waste a connection.
  try {
    parseKey(process.env.TOKEN_ENCRYPTION_KEY);
  } catch {
    console.error("TOKEN_ENCRYPTION_KEY is missing or not 32 bytes of base64");
    return Response.json({ error: "encryption_not_configured" }, { status: 503 });
  }

  try {
    if (invite.state === "reconnect" && invite.item) {
      const accessToken = decryptToken(invite.item.accessTokenEnc, invite.item.itemId);
      const linkToken = await createLinkToken({ clientUserId: invite.borrowerId, accessToken });
      return Response.json({ link_token: linkToken, mode: "update" });
    }
    const linkToken = await createLinkToken({ clientUserId: invite.borrowerId });
    return Response.json({ link_token: linkToken, mode: "new" });
  } catch (e) {
    console.error("link-token:", describePlaidError(e));
    return Response.json({ error: "link_token_failed" }, { status: 502 });
  }
}
