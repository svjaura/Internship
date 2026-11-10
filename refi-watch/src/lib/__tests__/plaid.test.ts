import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { MINIMAL_LOAN_KEYS, last4, mapLiabilities } from "../plaid-map";
import { verifyPlaidWebhook, webhookAction, type PlaidJwk } from "../plaid-webhook";

/** Shaped like a Plaid /liabilities/get response, with every field we must drop filled in. */
function sampleResponse() {
  return {
    accounts: [
      {
        account_id: "acc_mortgage",
        mask: "8890",
        name: "Plaid Mortgage",
        official_name: "Rocket 30 Year Fixed",
        type: "loan",
        subtype: "mortgage",
        balances: { available: null, current: 345678.9, limit: null, iso_currency_code: "USD" },
      },
      { account_id: "acc_checking", mask: "0000", balances: { current: 110 }, type: "depository", subtype: "checking" },
    ],
    item: { item_id: "item_1", institution_id: "ins_1", institution_name: "Rocket Mortgage", webhook: "https://x/api/plaid/webhook" },
    liabilities: {
      credit: null,
      student: null,
      mortgage: [
        {
          account_id: "acc_mortgage",
          account_number: "3120194154",
          current_late_fee: 25,
          escrow_balance: 3141.54,
          has_pmi: true,
          has_prepayment_penalty: true,
          interest_rate: { percentage: 7.125, type: "fixed" },
          last_payment_amount: 2862.0,
          last_payment_date: "2026-11-01",
          loan_term: "30 year",
          loan_type_description: "conventional",
          maturity_date: "2054-05-01",
          next_monthly_payment: 2861.98,
          next_payment_due_date: "2026-12-01",
          origination_date: "2024-04-04",
          origination_principal_amount: 365000,
          past_due_amount: 2304,
          property_address: { city: "Vestavia Hills", country: "US", postal_code: "35216", region: "AL", street: "1 Main St" },
          ytd_interest_paid: 20000,
          ytd_principal_paid: 3000,
        },
      ],
    },
    request_id: "req_1",
  };
}

describe("mapLiabilities (data minimization)", () => {
  it("keeps exactly the allowed fields", () => {
    const [loan] = mapLiabilities(sampleResponse());
    expect(Object.keys(loan).sort()).toEqual([...MINIMAL_LOAN_KEYS].sort());
    expect(loan).toEqual({
      plaid_account_id: "acc_mortgage",
      servicer_name: "Rocket Mortgage",
      interest_rate_percentage: 7.125,
      interest_rate_type: "fixed",
      current_balance: 345678.9,
      next_monthly_payment: 2861.98,
      next_payment_due_date: "2026-12-01",
      origination_date: "2024-04-04",
      origination_principal_amount: 365000,
      maturity_date: "2054-05-01",
      loan_term: "30 year",
      loan_type_description: "conventional",
      account_last4: "8890",
    });
  });

  it("drops escrow, PMI, address, past due, late fees, last payment, YTD and the full account number", () => {
    const json = JSON.stringify(mapLiabilities(sampleResponse()));
    for (const banned of ["escrow", "pmi", "property", "Vestavia", "past_due", "late_fee", "last_payment", "ytd", "prepayment", "3120194154", "account_number", "checking"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("only mortgages become loans; the checking account is ignored", () => {
    expect(mapLiabilities(sampleResponse())).toHaveLength(1);
  });

  it("falls back to the last 4 of the account number when there is no mask, and never keeps more", () => {
    const r = sampleResponse();
    r.accounts[0].mask = null as unknown as string;
    expect(mapLiabilities(r)[0].account_last4).toBe("4154");
    expect(last4("12-3456-7890")).toBe("7890");
    expect(last4(null)).toBeNull();
  });

  it("missing or malformed fields become null, never guessed", () => {
    const r = sampleResponse();
    const m = r.liabilities.mortgage[0] as Record<string, unknown>;
    m.interest_rate = { percentage: null, type: "hybrid" };
    m.next_payment_due_date = "12/01/2026";
    m.loan_term = null;
    r.accounts[0].balances.current = null as unknown as number;
    const [loan] = mapLiabilities(r);
    expect(loan.interest_rate_percentage).toBeNull();
    expect(loan.interest_rate_type).toBeNull();
    expect(loan.next_payment_due_date).toBeNull();
    expect(loan.loan_term).toBeNull();
    expect(loan.current_balance).toBeNull();
  });

  it("uses the institution name hint when the item has none", () => {
    const r = sampleResponse();
    r.item.institution_name = null as unknown as string;
    expect(mapLiabilities(r, "Rocket")[0].servicer_name).toBe("Rocket");
  });
});

describe("webhook verification", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const pub = { ...(await exportJWK(publicKey)), kid: "kid1", alg: "ES256", use: "sig", created_at: 1, expired_at: null } as PlaidJwk;
  const lookup = async (kid: string) => (kid === "kid1" ? pub : null);
  const body = JSON.stringify({ webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE", item_id: "item_1" });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const sign = (claims: Record<string, unknown>, kid = "kid1", iat?: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuedAt(iat ?? Math.floor(Date.now() / 1000))
      .sign(privateKey);

  it("accepts a valid signature over the exact body", async () => {
    expect(await verifyPlaidWebhook(body, await sign({ request_body_sha256: sha(body) }), lookup)).toEqual({ ok: true });
  });
  it("rejects a changed body", async () => {
    const jwt = await sign({ request_body_sha256: sha(body) });
    expect((await verifyPlaidWebhook(body + " ", jwt, lookup)).ok).toBe(false);
  });
  it("rejects an old token (over 5 minutes)", async () => {
    const jwt = await sign({ request_body_sha256: sha(body) }, "kid1", Math.floor(Date.now() / 1000) - 600);
    expect((await verifyPlaidWebhook(body, jwt, lookup)).ok).toBe(false);
  });
  it("rejects an unknown key, a missing header and another signer", async () => {
    expect((await verifyPlaidWebhook(body, await sign({ request_body_sha256: sha(body) }, "nope"), lookup)).ok).toBe(false);
    expect((await verifyPlaidWebhook(body, null, lookup)).ok).toBe(false);
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({ request_body_sha256: sha(body) }).setProtectedHeader({ alg: "ES256", kid: "kid1" }).setIssuedAt().sign(other.privateKey);
    expect((await verifyPlaidWebhook(body, forged, lookup)).ok).toBe(false);
  });
  it("rejects an expired key", async () => {
    const expiredLookup = async () => ({ ...pub, expired_at: 123 });
    expect((await verifyPlaidWebhook(body, await sign({ request_body_sha256: sha(body) }), expiredLookup)).ok).toBe(false);
  });
});

describe("webhookAction", () => {
  it("maps the webhooks the brief names", () => {
    expect(webhookAction({ webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE", item_id: "i" })).toEqual({ kind: "refresh", itemId: "i" });
    expect(webhookAction({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "i", error: { error_code: "ITEM_LOGIN_REQUIRED" } })).toEqual({ kind: "reconnect", itemId: "i", reason: "ITEM_LOGIN_REQUIRED" });
    expect(webhookAction({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "i" })).toEqual({ kind: "reconnect", itemId: "i", reason: "PENDING_EXPIRATION" });
    expect(webhookAction({ webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: "i" })).toEqual({ kind: "repaired", itemId: "i" });
    expect(webhookAction({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "i", error: { error_code: "INTERNAL_SERVER_ERROR" } })).toEqual({ kind: "ignore" });
    expect(webhookAction({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "i" })).toEqual({ kind: "ignore" });
    expect(webhookAction(null)).toEqual({ kind: "ignore" });
  });
});

describe("describePlaidError (safe log line)", () => {
  it("names the Plaid error code and request id, and says when Plaid was never reached", async () => {
    const { PlaidError } = await import("plaid");
    const { describePlaidError } = await import("../plaid");
    const api = new PlaidError({ statusCode: 400, body: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", request_id: "req_9" } });
    expect(describePlaidError(api)).toBe("Plaid 400 ITEM_ERROR/ITEM_LOGIN_REQUIRED request_id=req_9");
    expect(describePlaidError(new PlaidError({ message: "fetch failed" }))).toBe("Plaid not reached: fetch failed");
    expect(describePlaidError(new TypeError("x"))).toBe("TypeError");
  });
});
