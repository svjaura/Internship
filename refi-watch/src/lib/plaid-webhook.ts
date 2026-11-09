/**
 * Plaid webhook verification.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 *
 * 1. The Plaid-Verification header is a JWT signed with ES256.
 * 2. Its key id (kid) is looked up with /webhook_verification_key/get.
 * 3. The JWT must verify, be no older than 5 minutes, and its
 *    request_body_sha256 claim must equal the SHA-256 of the raw body.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

export interface PlaidJwk extends JWK {
  kid?: string;
  created_at?: number;
  expired_at?: number | null;
}

export type KeyLookup = (kid: string) => Promise<PlaidJwk | null>;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyPlaidWebhook(rawBody: string, jwt: string | null | undefined, getKey: KeyLookup, maxAgeSeconds = 300): Promise<VerifyResult> {
  if (!jwt) return { ok: false, reason: "missing Plaid-Verification header" };
  let header;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return { ok: false, reason: "malformed JWT" };
  }
  if (header.alg !== "ES256") return { ok: false, reason: "unexpected alg" };
  if (!header.kid) return { ok: false, reason: "missing kid" };

  const jwk = await getKey(header.kid);
  if (!jwk) return { ok: false, reason: "unknown key" };
  if (jwk.expired_at) return { ok: false, reason: "expired key" };

  let payload;
  try {
    const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, "ES256");
    ({ payload } = await jwtVerify(jwt, key, { algorithms: ["ES256"], maxTokenAge: `${maxAgeSeconds}s` }));
  } catch {
    return { ok: false, reason: "bad signature or too old" };
  }
  const claimed = typeof payload.request_body_sha256 === "string" ? payload.request_body_sha256 : "";
  const actual = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(claimed, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "body hash mismatch" };
  return { ok: true };
}

/** What a webhook asks Refi Watch to do. */
export type WebhookAction =
  | { kind: "refresh"; itemId: string }
  | { kind: "reconnect"; itemId: string; reason: string }
  | { kind: "repaired"; itemId: string }
  | { kind: "revoked"; itemId: string }
  | { kind: "ignore" };

export function webhookAction(body: unknown): WebhookAction {
  if (!body || typeof body !== "object") return { kind: "ignore" };
  const b = body as Record<string, unknown>;
  const type = String(b.webhook_type || "");
  const code = String(b.webhook_code || "");
  const itemId = typeof b.item_id === "string" ? b.item_id : "";
  if (!itemId) return { kind: "ignore" };
  const err = (b.error && typeof b.error === "object" ? b.error : {}) as Record<string, unknown>;
  if (type === "LIABILITIES" && code === "DEFAULT_UPDATE") return { kind: "refresh", itemId };
  if (type === "ITEM") {
    if (code === "ERROR" && err.error_code === "ITEM_LOGIN_REQUIRED") return { kind: "reconnect", itemId, reason: "ITEM_LOGIN_REQUIRED" };
    if (code === "PENDING_EXPIRATION") return { kind: "reconnect", itemId, reason: "PENDING_EXPIRATION" };
    if (code === "PENDING_DISCONNECT") return { kind: "reconnect", itemId, reason: "PENDING_DISCONNECT" };
    if (code === "LOGIN_REPAIRED") return { kind: "repaired", itemId };
    if (code === "USER_PERMISSION_REVOKED" || code === "USER_ACCOUNT_REVOKED") return { kind: "revoked", itemId };
  }
  return { kind: "ignore" };
}
