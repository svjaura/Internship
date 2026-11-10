/**
 * Don't lose a Trial connection slot: when the database refuses an exchanged item twice, the
 * exchange route logs one REFIWATCH_UNSAVED_ITEM line with the token already encrypted, and
 * recoverUnsavedItem (scripts/recover-item.ts) puts the item back from that line.
 * Plaid is mocked; the memory store stands in for Supabase.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "../crypto";
import { UNSAVED_ITEM_TAG, UnsavedItemLineError, formatUnsavedItemLine, parseUnsavedItemLine, type UnsavedItem } from "../unsaved-item";

const ACCESS_TOKEN = "access-production-9f8e7d6c-5b4a-3210-fedc-ba9876543210";
const ITEM_ID = "Ed6bjNrDLJfGvZWwnkQlfxwoNz54B5C97ejBr";
const ORG = "00000000-0000-4000-8000-000000000001";
const BORROWER = "4f0c2a5e-8f1b-4c7a-9d2e-1a2b3c4d5e6f";

vi.mock("../plaid", async () => {
  const { mapLiabilities } = await import("../plaid-map");
  return {
    exchangePublicToken: vi.fn(async () => ({ accessToken: ACCESS_TOKEN, itemId: ITEM_ID })),
    fetchMinimalLoans: vi.fn(async () =>
      mapLiabilities({
        accounts: [{ account_id: "acc1", mask: "2086", balances: { current: 355446.06 } }],
        item: { institution_name: "Rocket Mortgage" },
        liabilities: {
          mortgage: [
            {
              account_id: "acc1",
              interest_rate: { percentage: 7.125, type: "fixed" },
              next_monthly_payment: 2861.98,
              next_payment_due_date: "2026-12-01",
              origination_date: "2024-04-04",
              maturity_date: "2054-05-01",
            },
          ],
        },
      }),
    ),
    describePlaidError: () => "mock error",
    plaidErrorCode: () => undefined,
  };
});

const sample = (key: Buffer): UnsavedItem => ({
  item_id: ITEM_ID,
  org_id: ORG,
  borrower_id: BORROWER,
  institution_name: "Rocket Mortgage",
  access_token_enc: encryptToken(ACCESS_TOKEN, ITEM_ID, key),
  at: "2026-11-11T15:04:05.000Z",
  reason: "save item: connection terminated",
});

describe("REFIWATCH_UNSAVED_ITEM line", () => {
  const key = randomBytes(32);

  it("round-trips, and the line carries only the encrypted token", () => {
    const u = sample(key);
    const line = formatUnsavedItemLine(u);
    expect(line.startsWith(`${UNSAVED_ITEM_TAG} {`)).toBe(true);
    expect(line).not.toContain(ACCESS_TOKEN);
    expect(line).not.toMatch(/\n/);
    expect(parseUnsavedItemLine(line)).toEqual(u);
  });

  it("reads the line with a log prefix in front, and from a JSON log export with escaped quotes", () => {
    const u = sample(key);
    const line = formatUnsavedItemLine(u);
    expect(parseUnsavedItemLine(`2026-11-11 15:04:05.123 [error] ${line}  `)).toEqual(u);
    const exported = JSON.stringify({ level: "error", message: line, source: "lambda" });
    expect(parseUnsavedItemLine(exported)).toEqual(u);
  });

  it("refuses to log a token that isn't encrypted", () => {
    expect(() => formatUnsavedItemLine({ ...sample(key), access_token_enc: ACCESS_TOKEN })).toThrow(UnsavedItemLineError);
  });

  it("rejects a cut-off or tampered line with a clear reason", () => {
    const line = formatUnsavedItemLine(sample(key));
    expect(() => parseUnsavedItemLine("nothing here")).toThrow(/no REFIWATCH_UNSAVED_ITEM line/);
    expect(() => parseUnsavedItemLine(line.slice(0, -20))).toThrow(/cut off/);
    expect(() => parseUnsavedItemLine(line.replace(ORG, "not-a-uuid"))).toThrow(/org_id/);
    expect(() => parseUnsavedItemLine(line.replace(/"access_token_enc":"v1\./, '"access_token_enc":"access-'))).toThrow(/access_token_enc/);
  });
});

describe("exchange save failure -> log line -> recovery (memory store, Plaid mocked)", () => {
  let db: typeof import("../db");
  let exchange: typeof import("../../app/api/plaid/exchange/route");
  let recover: typeof import("../recover-item");
  let fetchMinimalLoans: ReturnType<typeof vi.fn>;
  let code: string;

  const post = (body: unknown) => new Request("http://localhost/api/plaid/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    process.env.PLAID_CLIENT_ID = "test-client";
    process.env.PLAID_SECRET_SANDBOX = "test-secret";
    process.env.PLAID_ENV = "sandbox";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];
    db = await import("../db");
    exchange = await import("../../app/api/plaid/exchange/route");
    recover = await import("../recover-item");
    fetchMinimalLoans = (await import("../plaid")).fetchMinimalLoans as unknown as ReturnType<typeof vi.fn>;
  });
  beforeEach(async () => {
    db.resetMemoryStore();
    code = (await db.getStore().createInvite(db.DEMO_ORG_ID, "Michael Weber", null)).code;
    fetchMinimalLoans.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function failSaveTwice(): Promise<string> {
    const store = db.getStore();
    vi.spyOn(store, "saveItem").mockRejectedValueOnce(new Error("save item: fetch failed")).mockRejectedValueOnce(new Error("save item: fetch failed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await exchange.POST(post({ invite: code, public_token: "public-production-x", institution_name: "Rocket Mortgage" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "save_failed" });

    const logged = errors.mock.calls.map((c) => c.map(String).join(" "));
    // Nothing logged anywhere carries the plaintext token.
    expect(logged.join("\n")).not.toContain(ACCESS_TOKEN);
    const tagged = logged.filter((l) => l.includes(UNSAVED_ITEM_TAG));
    expect(tagged).toHaveLength(1);
    errors.mockRestore();
    return tagged[0];
  }

  it("logs exactly one recoverable line, with the token encrypted and bound to the item", async () => {
    const line = await failSaveTwice();
    const u = parseUnsavedItemLine(line);
    const invite = await db.getStore().getInvite(code);
    expect(u).toMatchObject({ item_id: ITEM_ID, org_id: db.DEMO_ORG_ID, borrower_id: invite!.borrowerId, institution_name: "Rocket Mortgage" });
    expect(u.reason).toContain("fetch failed");
    const { decryptToken } = await import("../crypto");
    expect(decryptToken(u.access_token_enc, u.item_id)).toBe(ACCESS_TOKEN);
    expect(() => decryptToken(u.access_token_enc, "another-item")).toThrow();
    // Nothing was saved, and Plaid was not asked for the loan.
    expect(await db.getStore().getItem(ITEM_ID)).toBeNull();
    expect(fetchMinimalLoans).not.toHaveBeenCalled();
  });

  it("recovers the item from the line: dry run writes nothing, then insert + first refresh, no second connection", async () => {
    const u = parseUnsavedItemLine(await failSaveTwice());
    const store = db.getStore();
    const log: string[] = [];

    const dry = await recover.recoverUnsavedItem(u, { store, dryRun: true, log: (l) => log.push(l) });
    expect(dry).toMatchObject({ status: "dry_run", tokenEnv: "production" });
    expect(await store.getItem(ITEM_ID)).toBeNull();

    // PLAID_ENV is sandbox here, so a production token is saved but not refreshed with the wrong keys.
    const res = await recover.recoverUnsavedItem(u, { store, log: (l) => log.push(l) });
    expect(res).toMatchObject({ status: "inserted", itemId: ITEM_ID, refresh: "skipped" });
    expect(fetchMinimalLoans).not.toHaveBeenCalled();
    const saved = await store.getItem(ITEM_ID);
    expect(saved).toMatchObject({ itemId: ITEM_ID, accessTokenEnc: u.access_token_enc, status: "ok", institutionName: "Rocket Mortgage" });
    expect((await store.getInvite(code))?.state).toBe("connected");
    expect(log.join("\n")).not.toContain(ACCESS_TOKEN);

    // Running it again is harmless.
    expect((await recover.recoverUnsavedItem(u, { store })).status).toBe("already_saved");
  });

  it("runs the first /liabilities/get when the Plaid keys match the token's environment", async () => {
    const u = parseUnsavedItemLine(await failSaveTwice());
    process.env.PLAID_ENV = "production";
    process.env.PLAID_SECRET_PRODUCTION = "test-prod-secret";
    try {
      const res = await recover.recoverUnsavedItem(u, { store: db.getStore() });
      expect(res.refresh).toEqual({ ok: true, loans: 1 });
      expect(fetchMinimalLoans).toHaveBeenCalledWith(ACCESS_TOKEN, "Rocket Mortgage");
      const d = await db.getStore().loadDashboard(db.DEMO_ORG_ID);
      expect(d.records.find((r) => r.borrower === "Michael Weber")?.interest_rate.percentage).toBe(7.125);
    } finally {
      process.env.PLAID_ENV = "sandbox";
      delete process.env.PLAID_SECRET_PRODUCTION;
    }
  });

  it("refuses a line encrypted with another key, and refuses to run without Supabase", async () => {
    const other = sample(randomBytes(32));
    await expect(recover.recoverUnsavedItem(other, { store: db.getStore() })).rejects.toThrow(/does not decrypt with this TOKEN_ENCRYPTION_KEY/);
    const u = parseUnsavedItemLine(await failSaveTwice());
    await expect(recover.recoverUnsavedItem(u)).rejects.toThrow(/Supabase is not configured/);
  });

  it("the first failed save is retried, and a retry that works logs no recovery line", async () => {
    vi.spyOn(db.getStore(), "saveItem").mockRejectedValueOnce(new Error("save item: blip"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await exchange.POST(post({ invite: code, public_token: "public-production-x" }));
    expect(res.status).toBe(200);
    expect(errors.mock.calls.some((c) => String(c[0]).includes(UNSAVED_ITEM_TAG))).toBe(false);
    expect(await db.getStore().getItem(ITEM_ID)).not.toBeNull();
  });
});
