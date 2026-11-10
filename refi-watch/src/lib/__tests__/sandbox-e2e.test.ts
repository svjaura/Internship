/**
 * The sandbox end-to-end run (scripts/sandbox-e2e.ts) with the Plaid SDK mocked: the real
 * src/lib/plaid.ts, exchange route, crypto, refresh, mapping, memory store and rule engine run;
 * only the HTTP calls to Plaid are replaced. Plaid itself is not reachable from CI.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ACCESS_TOKEN = "access-sandbox-1111-2222-3333-4444";
const ITEM_ID = "item_sandbox_e2e";
const WEBHOOK = "https://refi-watch.example.com/api/plaid/webhook";

const calls = {
  createPublicToken: [] as Array<Record<string, unknown>>,
  exchange: [] as Array<Record<string, unknown>>,
  liabilities: [] as string[],
  fireWebhook: [] as Array<Record<string, unknown>>,
};
let failLiabilities = false;

/** Shaped like Plaid Sandbox's /liabilities/get for user_good at First Platypus Bank. */
function sandboxLiabilities() {
  return {
    accounts: [
      { account_id: "acc_mortgage", mask: "8888", name: "Plaid Mortgage", type: "loan", subtype: "mortgage", balances: { current: 56302.06, available: null } },
      { account_id: "acc_student", mask: "7777", type: "loan", subtype: "student", balances: { current: 65262 } },
    ],
    item: { item_id: ITEM_ID, institution_id: "ins_109508", institution_name: null },
    liabilities: {
      student: [{ account_id: "acc_student" }],
      mortgage: [
        {
          account_id: "acc_mortgage",
          account_number: "3120194154",
          current_late_fee: 25,
          escrow_balance: 3141.54,
          has_pmi: true,
          has_prepayment_penalty: true,
          interest_rate: { percentage: 3.99, type: "fixed" },
          last_payment_amount: 3141.54,
          last_payment_date: "2019-08-01",
          loan_term: "30 year",
          loan_type_description: "conventional",
          maturity_date: "2045-07-31",
          next_monthly_payment: 3141.54,
          next_payment_due_date: "2019-11-15",
          origination_date: "2015-08-01",
          origination_principal_amount: 425000,
          past_due_amount: 2304,
          property_address: { city: "Malakoff", country: "US", postal_code: "14236", region: "NY", street: "2992 Cameron Road" },
          ytd_interest_paid: 12300.4,
          ytd_principal_paid: 12340.5,
        },
      ],
    },
    request_id: "req_liab",
  };
}

vi.mock("plaid", async (orig) => {
  const actual = await orig<typeof import("plaid")>();
  class FakePlaidClient {
    sandbox = {
      createPublicToken: async (req: Record<string, unknown>) => {
        calls.createPublicToken.push(req);
        return { public_token: "public-sandbox-e2e", request_id: "req_pt" };
      },
      fireItemWebhook: async (req: Record<string, unknown>) => {
        calls.fireWebhook.push(req);
        return { webhook_fired: true, request_id: "req_fw" };
      },
    };
    item = {
      exchangePublicToken: async (req: Record<string, unknown>) => {
        calls.exchange.push(req);
        return { access_token: ACCESS_TOKEN, item_id: ITEM_ID, request_id: "req_ex" };
      },
    };
    liabilities = {
      get: async (req: { access_token: string }) => {
        calls.liabilities.push(req.access_token);
        if (failLiabilities) throw new actual.PlaidError({ statusCode: 400, body: { error_type: "ITEM_ERROR", error_code: "PRODUCTS_NOT_SUPPORTED", request_id: "req_bad" } });
        return sandboxLiabilities();
      },
    };
    institutions = { getById: async () => ({ institution: { name: "First Platypus Bank" } }) };
  }
  return { ...actual, PlaidClient: FakePlaidClient };
});

describe("sandbox end-to-end run (Plaid SDK mocked)", () => {
  let e2e: typeof import("../sandbox-e2e");
  let db: typeof import("../db");
  const log: string[] = [];

  beforeAll(async () => {
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET_SANDBOX = "test-sandbox-secret";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    e2e = await import("../sandbox-e2e");
    db = await import("../db");
  });
  beforeEach(() => {
    process.env.PLAID_ENV = "sandbox";
    delete process.env.PLAID_WEBHOOK_URL;
    for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];
    for (const list of Object.values(calls)) list.length = 0;
    failLiabilities = false;
    log.length = 0;
    db.resetMemoryStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a Liabilities sandbox item, exchanges it through the app, maps, checks the rule and fires DEFAULT_UPDATE", async () => {
    const res = await e2e.runSandboxE2E({ webhookUrl: WEBHOOK, asOf: "2026-11-10", log: (l) => log.push(l) });

    expect(calls.createPublicToken).toEqual([{ institution_id: "ins_109508", initial_products: ["liabilities"], options: { webhook: WEBHOOK } }]);
    expect(calls.exchange).toEqual([{ public_token: "public-sandbox-e2e" }]);
    // One /liabilities/get from the exchange route, one from the local DEFAULT_UPDATE refresh.
    expect(calls.liabilities).toEqual([ACCESS_TOKEN, ACCESS_TOKEN]);
    // The webhook is fired with the decrypted token, for LIABILITIES DEFAULT_UPDATE.
    expect(calls.fireWebhook).toEqual([{ access_token: ACCESS_TOKEN, webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE" }]);

    expect(res.itemId).toBe(ITEM_ID);
    expect(res.webhook).toEqual({ fired: true, url: WEBHOOK });
    expect(res.webhookRefresh).toEqual({ ok: true, loans: 1 });
    const stored = await db.getStore().getItem(ITEM_ID);
    expect(stored?.accessTokenEnc.startsWith("v1.")).toBe(true);
    expect(stored?.accessTokenEnc).not.toContain(ACCESS_TOKEN);

    expect(res.loans).toHaveLength(1);
    const { rec, r } = res.loans[0];
    expect(rec).toMatchObject({
      borrower: e2e.SANDBOX_BORROWER,
      servicer: "First Platypus Bank",
      connection: "ok",
      interest_rate: { percentage: 3.99, type: "fixed" },
      current_balance: 56302.06,
      next_monthly_payment: 3141.54,
      next_payment_due_date: "2019-11-15",
      origination_principal_amount: 425000,
      loan_term: "30 year",
      mask: "8888",
    });
    // Only allowed fields made it through.
    expect(JSON.stringify(rec)).not.toMatch(/escrow|pmi|property|Cameron|2304|late_fee|ytd|3120194154|acc_student/i);
    expect(r.status).toBe("notyet");
    expect(r.notes).toEqual([]);

    const text = e2e.formatLoanSummary(res.loans[0], res.settings, res.asOf).join("\n");
    for (const s of [
      "First Platypus Bank, ending 8888",
      "From the servicer, through Plaid",
      "3.990% fixed",
      "$56,302.06",
      "$3,141.54",
      "Nov 15, 2019",
      "Current P&I",
      "the note: $425,000.00 at 3.990% over 360 months",
      "New P&I",
      "Monthly savings",
      "Payback",
      "Status                Not yet",
      "Reason                Your rule: below today's rate",
    ]) {
      expect(text).toContain(s);
    }
    const all = [...log, text].join("\n");
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).not.toContain("public-sandbox-e2e");
    expect(all).not.toContain("test-sandbox-secret");
    expect(log).toHaveLength(5);
  });

  it("skips the webhook when no URL is set, and honors an institution override", async () => {
    const res = await e2e.runSandboxE2E({ institutionId: "ins_custom", asOf: "2026-11-10" });
    expect(calls.createPublicToken[0]).toEqual({ institution_id: "ins_custom", initial_products: ["liabilities"] });
    expect(calls.fireWebhook).toEqual([]);
    expect(res.webhook).toEqual({ fired: false, reason: "PLAID_WEBHOOK_URL is not set" });
    expect(res.webhookRefresh.ok).toBe(true);
  });

  it("uses PLAID_WEBHOOK_URL by default", async () => {
    process.env.PLAID_WEBHOOK_URL = WEBHOOK;
    await e2e.runSandboxE2E({ asOf: "2026-11-10" });
    expect(calls.fireWebhook).toHaveLength(1);
  });

  it("refuses to run unless PLAID_ENV is sandbox, before calling Plaid", async () => {
    process.env.PLAID_ENV = "production";
    await expect(e2e.runSandboxE2E()).rejects.toThrow(/only runs against Plaid Sandbox/);
    process.env.PLAID_ENV = "development";
    await expect(e2e.runSandboxE2E()).rejects.toThrow(/only runs against Plaid Sandbox/);
    expect(calls.createPublicToken).toEqual([]);
  });

  it("refuses the .env.example placeholder webhook URL (someone else's domain)", async () => {
    process.env.PLAID_WEBHOOK_URL = "https://your-app.vercel.app/api/plaid/webhook";
    await expect(e2e.runSandboxE2E()).rejects.toThrow(/placeholder/);
    expect(calls.createPublicToken).toEqual([]);
  });

  it("refuses to write to Supabase", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    await expect(e2e.runSandboxE2E()).rejects.toThrow(/in-memory store/);
    expect(calls.createPublicToken).toEqual([]);
  });

  it("reports a failed /liabilities/get without leaking the token", async () => {
    failLiabilities = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = await e2e.runSandboxE2E({ asOf: "2026-11-10" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(e2e.SandboxRunError);
    expect((err as Error).message).toMatch(/first \/liabilities\/get/);
    expect((err as Error).message).not.toContain(ACCESS_TOKEN);
  });
});
