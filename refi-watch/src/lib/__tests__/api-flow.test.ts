/**
 * End-to-end server flow with Plaid mocked (no network): link token -> exchange ->
 * encrypted storage -> /liabilities/get mapping -> dashboard record -> signed webhooks
 * (DEFAULT_UPDATE refresh, ITEM_LOGIN_REQUIRED reconnect) -> update-mode link token.
 * Runs against the in-memory store (no Supabase keys).
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaidJwk } from "../plaid-webhook";

const ACCESS_TOKEN = "access-sandbox-aaaa-bbbb-cccc-dddd";
const ITEM_ID = "item_sandbox_123";
let mortgageRate = 7.125;

// after() runs work once the response is sent; here it runs at once and the test awaits it.
const pendingAfter: unknown[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void pendingAfter.push(fn()) }));
const flushAfter = async () => {
  await Promise.all(pendingAfter.splice(0));
};

const keys = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig", created_at: 1, expired_at: null } as PlaidJwk;

const plaidCalls = { linkTokens: [] as Array<{ clientUserId: string; accessToken?: string }>, liabilities: [] as string[] };
vi.mock("../plaid", async () => {
  const { mapLiabilities } = await import("../plaid-map");
  return {
    createLinkToken: vi.fn(async (o: { clientUserId: string; accessToken?: string }) => {
      plaidCalls.linkTokens.push(o);
      return o.accessToken ? "link-update-token" : "link-new-token";
    }),
    exchangePublicToken: vi.fn(async () => ({ accessToken: ACCESS_TOKEN, itemId: ITEM_ID })),
    fetchMinimalLoans: vi.fn(async (accessToken: string) => {
      plaidCalls.liabilities.push(accessToken);
      return mapLiabilities({
        accounts: [{ account_id: "acc1", mask: "2086", balances: { current: 355446.06 } }],
        item: { institution_name: "Rocket Mortgage" },
        liabilities: {
          mortgage: [
            {
              account_id: "acc1",
              account_number: "99992086",
              escrow_balance: 1234,
              property_address: { street: "1 Main" },
              interest_rate: { percentage: mortgageRate, type: "fixed" },
              loan_term: "30 year",
              loan_type_description: "conventional",
              maturity_date: "2054-05-01",
              next_monthly_payment: 2861.98,
              next_payment_due_date: "2026-12-01",
              origination_date: "2024-04-04",
              origination_principal_amount: 365000,
            },
          ],
        },
      });
    }),
    getWebhookKey: vi.fn(async (kid: string) => (kid === "k1" ? jwk : null)),
    describePlaidError: () => "mock error",
    plaidErrorCode: () => undefined,
  };
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function signedWebhook(body: object) {
  const raw = JSON.stringify(body);
  const sha = createHash("sha256").update(raw).digest("hex");
  const jwt = await new SignJWT({ request_body_sha256: sha }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuedAt().sign(keys.privateKey);
  return post(raw, { "plaid-verification": jwt });
}

describe("connect, refresh and webhook flow (Plaid mocked, memory store)", () => {
  let db: typeof import("../db");
  let linkToken: typeof import("../../app/api/plaid/link-token/route");
  let exchange: typeof import("../../app/api/plaid/exchange/route");
  let webhook: typeof import("../../app/api/plaid/webhook/route");
  let rules: typeof import("../rules");
  let code: string;

  beforeAll(async () => {
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET_SANDBOX = "test-secret";
    process.env.PLAID_ENV = "sandbox";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SUPABASE_URL;
    db = await import("../db");
    linkToken = await import("../../app/api/plaid/link-token/route");
    exchange = await import("../../app/api/plaid/exchange/route");
    webhook = await import("../../app/api/plaid/webhook/route");
    rules = await import("../rules");
    db.resetMemoryStore();
    code = (await db.getStore().createInvite(db.DEMO_ORG_ID, "Michael Weber", "michael@example.com")).code;
  });
  beforeEach(() => {
    mortgageRate = 7.125;
  });

  const michael = async () => {
    const d = await db.getStore().loadDashboard(db.DEMO_ORG_ID);
    return d.records.find((r) => r.borrower === "Michael Weber");
  };

  it("refuses a link token without consent, and for an unknown invite", async () => {
    expect((await linkToken.POST(post({ invite: code }))).status).toBe(400);
    expect((await linkToken.POST(post({ invite: "nope-nope-nope-nope", consent: true }))).status).toBe(404);
  });

  it("creates a Liabilities link token for a new borrower", async () => {
    const res = await linkToken.POST(post({ invite: code, consent: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link_token: "link-new-token", mode: "new" });
    expect(plaidCalls.linkTokens.at(-1)?.accessToken).toBeUndefined();
  });

  it("exchanges the public token, stores the access token encrypted, and loads the loan", async () => {
    const res = await exchange.POST(post({ invite: code, public_token: "public-sandbox-x", institution_name: "Rocket Mortgage" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, firstName: "Michael", refreshed: true });
    expect(JSON.stringify(body)).not.toMatch(/\$|savings|newPI|payback/i);

    const item = await db.getStore().getItem(ITEM_ID);
    expect(item?.accessTokenEnc.startsWith("v1.")).toBe(true);
    expect(item?.accessTokenEnc).not.toContain(ACCESS_TOKEN);
    expect(plaidCalls.liabilities).toContain(ACCESS_TOKEN);

    const rec = await michael();
    expect(rec).toMatchObject({
      servicer: "Rocket Mortgage",
      connection: "ok",
      interest_rate: { percentage: 7.125, type: "fixed" },
      current_balance: 355446.06,
      next_monthly_payment: 2861.98,
      next_payment_due_date: "2026-12-01",
      mask: "2086",
    });
    expect(JSON.stringify(rec)).not.toMatch(/escrow|Main|99992086/);
    const r = rules.evaluate(rec!, rules.DEFAULT_SETTINGS, "standard", "2026-11-09");
    expect(Math.round(r.currentPI * 100) / 100).toBe(2459.07);
    expect(r.status).toBe("ready");
  });

  it("refuses a second connection for the same borrower (no duplicate Trial slot)", async () => {
    expect((await linkToken.POST(post({ invite: code, consent: true }))).status).toBe(409);
    expect((await exchange.POST(post({ invite: code, public_token: "public-sandbox-y" }))).status).toBe(409);
  });

  it("rejects an unsigned or tampered webhook", async () => {
    const body = { webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE", item_id: ITEM_ID };
    expect((await webhook.POST(post(body))).status).toBe(401);
    const good = await signedWebhook(body);
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ ...body, item_id: "other" }) });
    expect((await webhook.POST(tampered)).status).toBe(401);
  });

  it("LIABILITIES DEFAULT_UPDATE re-fetches the loan and rechecks the rule", async () => {
    mortgageRate = 6.5; // the servicer now reports a lower rate
    const before = plaidCalls.liabilities.length;
    const res = await webhook.POST(await signedWebhook({ webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE", item_id: ITEM_ID }));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(plaidCalls.liabilities.length).toBe(before + 1);
    const rec = await michael();
    expect(rec?.interest_rate.percentage).toBe(6.5);
  });

  it("ITEM ERROR ITEM_LOGIN_REQUIRED sets Reconnect, and the next link token is update mode", async () => {
    const res = await webhook.POST(await signedWebhook({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: ITEM_ID, error: { error_code: "ITEM_LOGIN_REQUIRED" } }));
    expect(res.status).toBe(200);
    const rec = await michael();
    expect(rec?.connection).toBe("login_required");
    expect(rules.evaluate(rec!, rules.DEFAULT_SETTINGS, "standard", "2026-11-09").status).toBe("reconnect");

    const lt = await linkToken.POST(post({ invite: code, consent: true }));
    expect(await lt.json()).toEqual({ link_token: "link-update-token", mode: "update" });
    expect(plaidCalls.linkTokens.at(-1)?.accessToken).toBe(ACCESS_TOKEN);

    // Finishing update mode does not exchange again; it marks the item ok and refreshes.
    const done = await exchange.POST(post({ invite: code, public_token: "public-update" }));
    expect(done.status).toBe(200);
    expect((await michael())?.connection).toBe("ok");
  });

  it("ITEM PENDING_EXPIRATION also flags Reconnect", async () => {
    await webhook.POST(await signedWebhook({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: ITEM_ID, consent_expiration_time: "2026-12-01T00:00:00Z" }));
    expect((await michael())?.connection).toBe("pending_expiration");
  });
});
