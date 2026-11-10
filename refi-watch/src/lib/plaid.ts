/**
 * Plaid client and the four calls Refi Watch makes. Server only.
 *
 * Never log a Plaid response or error object whole: error objects can carry
 * request headers (the secret), and responses carry fields we must not keep.
 */
import "server-only";
import { PlaidClient, PlaidEnvironment, PlaidError } from "plaid";
import { ORG_DISPLAY, plaidConfigured, plaidEnv, plaidRedirectUri, plaidSecret, plaidWebhookUrl } from "./config";
import { mapLiabilities, type MinimalLoan } from "./plaid-map";
import type { PlaidJwk } from "./plaid-webhook";

let client: PlaidClient | null = null;

export function getPlaid(): PlaidClient {
  if (!plaidConfigured()) throw new Error("Plaid is not configured (PLAID_CLIENT_ID and the secret for PLAID_ENV)");
  if (!client) {
    client = new PlaidClient({
      environment: plaidEnv() === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox,
      clientId: process.env.PLAID_CLIENT_ID,
      secret: plaidSecret(),
      timeoutInSeconds: 20,
    });
  }
  return client;
}

/** Plaid's error_code from a thrown error, if it is a Plaid API error. */
export function plaidErrorCode(e: unknown): string | undefined {
  if (e instanceof PlaidError && e.body && typeof e.body === "object") {
    const code = (e.body as Record<string, unknown>).error_code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Safe one-line description of an error for logs. Never includes headers, tokens or response data. */
export function describePlaidError(e: unknown): string {
  if (e instanceof PlaidError) {
    // No HTTP status: Plaid was never reached (DNS, network, timeout). The message is the fetch error.
    if (e.statusCode === undefined && !e.body) return `Plaid not reached: ${String(e.message || "network error").slice(0, 120)}`;
    const b = (e.body && typeof e.body === "object" ? e.body : {}) as Record<string, unknown>;
    return `Plaid ${e.statusCode ?? "?"} ${String(b.error_type ?? "")}/${String(b.error_code ?? "")} request_id=${String(b.request_id ?? e.requestId ?? "")}`;
  }
  return e instanceof Error ? e.name : "unknown error";
}

/**
 * Link token for one borrower.
 * New connection: products ["liabilities"], mortgage accounts only.
 * Update mode (reconnect): pass the existing access token. Plaid reuses the
 * same Item, so no new connection is created and no Trial slot is used.
 */
export async function createLinkToken(opts: { clientUserId: string; accessToken?: string }): Promise<string> {
  const webhook = plaidWebhookUrl();
  const redirectUri = plaidRedirectUri();
  const res = await getPlaid().link.createToken({
    client_name: ORG_DISPLAY.name,
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: opts.clientUserId },
    ...(opts.accessToken
      ? { access_token: opts.accessToken }
      : { products: ["liabilities"], account_filters: { loan: { account_subtypes: ["mortgage"] } } }),
    ...(webhook ? { webhook } : {}),
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
  return res.link_token;
}

export async function exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
  const res = await getPlaid().item.exchangePublicToken({ public_token: publicToken });
  return { accessToken: res.access_token, itemId: res.item_id };
}

/** /liabilities/get, reduced at once to the allowed fields. The raw response is not returned or kept. */
export async function fetchMinimalLoans(accessToken: string, institutionNameHint?: string | null): Promise<MinimalLoan[]> {
  const res = await getPlaid().liabilities.get({ access_token: accessToken });
  let institution = res.item?.institution_name ?? institutionNameHint ?? null;
  if (!institution && res.item?.institution_id) {
    try {
      const inst = await getPlaid().institutions.getById({ institution_id: res.item.institution_id, country_codes: ["US"] });
      institution = inst.institution?.name ?? null;
    } catch {
      institution = null;
    }
  }
  return mapLiabilities(res, institution);
}

/** Webhook verification keys, cached by key id. */
const keyCache = new Map<string, { jwk: PlaidJwk; at: number }>();
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

export async function getWebhookKey(kid: string): Promise<PlaidJwk | null> {
  const hit = keyCache.get(kid);
  if (hit && Date.now() - hit.at < KEY_TTL_MS && !hit.jwk.expired_at) return hit.jwk;
  try {
    const res = await getPlaid().webhook.getVerificationKey({ key_id: kid });
    const jwk = res.key as unknown as PlaidJwk;
    keyCache.set(kid, { jwk, at: Date.now() });
    return jwk;
  } catch (e) {
    console.error("webhook key lookup failed:", describePlaidError(e));
    return null;
  }
}
