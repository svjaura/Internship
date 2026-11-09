import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  countStatuses,
  evaluate,
  monthlyPI,
  reasonText,
  sanitizeSettings,
  todayISO,
  type PresetId,
  type RuleSettings,
  type ServicerRecord,
} from "../rules";
import { DEMO_AS_OF, FLOW_LOAN, TEST_LOANS, buildServicerRecord, demoRecords } from "../demo-data";
import { AS_OF, countPayments, expected, makeRecord, monthsSince } from "./reference-model";

const cents = (x: number) => Math.round(x * 100) / 100;
const S = (over: Partial<RuleSettings> = {}): RuleSettings => ({ ...DEFAULT_SETTINGS, ...over });
const ev = (rec: ServicerRecord, s: RuleSettings = S(), preset: PresetId = "standard") => evaluate(rec, s, preset, DEMO_AS_OF);

const jordan = () => buildServicerRecord(FLOW_LOAN);
const dana = () => buildServicerRecord(TEST_LOANS.find((t) => t.id === "L01")!);

describe("demo date", () => {
  it("uses the demo's as-of date, Mon Nov 9, 2026", () => {
    expect(DEMO_AS_OF).toBe("2026-11-09");
    expect(AS_OF).toBe(DEMO_AS_OF);
  });
  it("todayISO formats a date in Central time", () => {
    // 2026-11-10 03:00 UTC is still Nov 9 in Alabama.
    expect(todayISO("America/Chicago", new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
  });
});

describe("monthlyPI", () => {
  it("$100,000 at 6% over 360 months is $599.55", () => {
    expect(cents(monthlyPI(100000, 6, 360))).toBe(599.55);
  });
  it("no payments left gives NaN, never a number", () => {
    expect(Number.isNaN(monthlyPI(1000, 6, 0))).toBe(true);
  });
  it("a zero rate divides evenly", () => {
    expect(monthlyPI(1200, 0, 12)).toBe(100);
  });
});

describe("Jordan Avery (7.125%, $365,000, 360 months, closed Apr 4, 2024)", () => {
  it("servicer record matches the payment schedule", () => {
    const rec = jordan();
    const sched = makeRecord({ P: 365000, rate: 7.125, n: 360, orig: "2024-04-04" });
    expect(rec.current_balance).toBe(sched.current_balance);
    expect(rec.next_payment_due_date).toBe("2026-12-01");
    expect(rec.maturity_date).toBe("2054-05-01");
    expect(sched._made).toBe(30);
  });
  it("current P&I is $2,459.07 (from the note)", () => {
    expect(cents(ev(jordan()).currentPI)).toBe(2459.07);
  });
  it("at 6.125%: saves $229.28, paid back in 18 months, Ready", () => {
    const r = ev(jordan(), S({ todayRate: 6.125 }));
    expect(cents(r.savings)).toBe(229.28);
    expect(r.paybackMonths).toBe(18);
    expect(r.status).toBe("ready");
    expect(reasonText(r)).toBe("Your rule: passes all 4 lines");
  });
  it("at 6.375%: new P&I $2,286.19, saves $172.88, paid back in 24 months, Ready", () => {
    const r = ev(jordan(), S({ todayRate: 6.375 }));
    expect(cents(r.newPI)).toBe(2286.19);
    expect(cents(r.savings)).toBe(172.88);
    expect(r.paybackMonths).toBe(24);
    expect(r.status).toBe("ready");
  });
  it('at 6.75%: saves $87.12, Not yet, "rate 0.375 lower, needs 0.75"', () => {
    const r = ev(jordan(), S({ todayRate: 6.75 }));
    expect(cents(r.savings)).toBe(87.12);
    expect(r.status).toBe("notyet");
    expect(reasonText(r)).toBe("Your rule: rate 0.375 lower, needs 0.75");
  });
});

describe("Dana Whitfield (7.875%, $342,000, closed Oct 6, 2023)", () => {
  it("matches the schedule: 36 paid, 324 left, balance $332,477.42, next due Dec 1, 2026, maturity Nov 1, 2053", () => {
    const rec = dana();
    const r = ev(rec);
    expect(rec.current_balance).toBe(332477.42);
    expect(rec.next_payment_due_date).toBe("2026-12-01");
    expect(rec.maturity_date).toBe("2053-11-01");
    expect(r.paymentsLeft).toBe(324);
    expect(makeRecord({ P: 342000, rate: 7.875, n: 360, orig: "2023-10-06" })._made).toBe(36);
  });
  it("current P&I is $2,479.74", () => {
    expect(cents(ev(dana()).currentPI)).toBe(2479.74);
  });
  it("at 6.125%: new P&I $2,100.63, saves $379.11, paid back in 11 months, Ready", () => {
    const r = ev(dana(), S({ todayRate: 6.125 }));
    expect(cents(r.newPI)).toBe(2100.63);
    expect(cents(r.savings)).toBe(379.11);
    expect(r.paybackMonths).toBe(11);
    expect(r.status).toBe("ready");
  });
  it("at 6.875%: saves $219.93, paid back in 19 months", () => {
    const r = ev(dana(), S({ todayRate: 6.875 }));
    expect(cents(r.savings)).toBe(219.93);
    expect(r.paybackMonths).toBe(19);
    expect(r.status).toBe("ready");
  });
});

describe("other hand-checked test loans", () => {
  const byId = (id: string) => buildServicerRecord([FLOW_LOAN, ...TEST_LOANS].find((t) => t.id === id)!);
  it("L07 (reconnect) is built as of its last good update, Tue Nov 3: 29 payments, balance $288,357.80", () => {
    const rec = byId("L07");
    expect(rec.current_balance).toBe(288357.8);
    expect(makeRecord({ P: 296000, rate: 7.0, n: 360, orig: "2024-05-06", asOf: "2026-11-03" })._made).toBe(29);
    expect(ev(rec).status).toBe("reconnect");
  });
  it("L08 is held for seasoning until Dec 3, 2026", () => {
    const r = ev(byId("L08"));
    expect(r.heldForSeasoning).toBe(true);
    expect(r.eligibleDate).toBe("2026-12-03");
    expect(r.status).toBe("notyet");
    expect(reasonText(r)).toBe("Your rule: 5 of 6 months since closing");
  });
  it("L09 (15-year) has 135 payments left", () => {
    expect(ev(byId("L09")).paymentsLeft).toBe(135);
  });
  it("L04 (ARM) uses the balance over the payments left and carries the ARM note", () => {
    const rec = byId("L04");
    const r = ev(rec);
    expect(r.rateType).toBe("variable");
    expect(cents(r.currentPI)).toBe(cents(monthlyPI(rec.current_balance!, 6.625, r.paymentsLeft)));
    expect(r.notes).toEqual(["ARM: check the next rate adjustment date."]);
  });
});

describe("all 13 demo loans against the independent model", () => {
  const settingsGrid: Array<[string, RuleSettings, PresetId]> = [
    ["defaults", S(), "standard"],
    ["VA preset", S(), "va"],
    ["FHA preset", S(), "fha"],
    ["6.375%, new 30-year term", S({ todayRate: 6.375, newTerm: "360" }), "standard"],
    ["5.5%, roll costs in", S({ todayRate: 5.5, rollCosts: true, closingCosts: 6500 }), "standard"],
    ["7.25%, tight rule", S({ todayRate: 7.25, minDrop: 0.25, minSavings: 50, maxPayback: 24, minSeasoning: 12 }), "standard"],
  ];
  for (const [label, s, preset] of settingsGrid) {
    it(`${label}: every number and status matches within $0.01`, () => {
      const bad: string[] = [];
      for (const rec of demoRecords()) {
        const r = evaluate(rec, s, preset, DEMO_AS_OF);
        const e = expected(rec, s, preset);
        if (r.status !== e.status) bad.push(`${rec.id}.status ${r.status} vs ${e.status}`);
        if (r.ruleName !== e.ruleName) bad.push(`${rec.id}.rule ${r.ruleName} vs ${e.ruleName}`);
        if (!e.complete) continue;
        const pairs: Array<[string, number, number]> = [
          ["currentPI", r.currentPI, e.currentPI],
          ["newPI", r.newPI, e.newPI],
          ["savings", r.savings, e.savings],
          ["interestLeftCurrent", r.interestLeftCurrent, e.interestLeftCurrent],
          ["interestLeftNew", r.interestLeftNew, e.interestLeftNew],
          ["interestNew30", r.interestNew30, e.interestNew30],
          ["interestNewKeep", r.interestNewKeep, e.interestNewKeep],
        ];
        for (const [k, a, b] of pairs) if (!(Math.abs(a - b) <= 0.01)) bad.push(`${rec.id}.${k} ${a} vs ${b}`);
        if (r.paymentsLeft !== e.left) bad.push(`${rec.id}.paymentsLeft ${r.paymentsLeft} vs ${e.left}`);
        if (r.monthsSinceClosing !== e.since) bad.push(`${rec.id}.since ${r.monthsSinceClosing} vs ${e.since}`);
        if (r.newTermMonths !== e.newN) bad.push(`${rec.id}.newTerm ${r.newTermMonths} vs ${e.newN}`);
        if (r.paybackMonths !== e.payback) bad.push(`${rec.id}.payback ${r.paybackMonths} vs ${e.payback}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it("every test record matches the schedule (balance, payment with escrow, next due, maturity, term)", () => {
    const bad: string[] = [];
    for (const t of [FLOW_LOAN, ...TEST_LOANS]) {
      const rec = buildServicerRecord(t);
      const m = makeRecord({ P: t.originalAmount, rate: t.rate, n: t.termMonths, orig: t.originationDate, escrow: t.escrowMonthly, asOf: t.asOf || AS_OF });
      for (const k of ["current_balance", "next_monthly_payment", "next_payment_due_date", "maturity_date", "loan_term"] as const) {
        if (rec[k] !== m[k]) bad.push(`${t.id}.${k} ${rec[k]} vs ${m[k]}`);
      }
      if (m._made + countPayments(rec.next_payment_due_date!, rec.maturity_date!) !== t.termMonths) bad.push(`${t.id} made + left != term`);
    }
    expect(bad).toEqual([]);
  });

  it("the demo's hand-checked counts: 12 loans standard 2/3/6/1, VA 3/2/6/1, FHA 2/3/6/1; with Jordan 3/3/6/1", () => {
    const twelve = TEST_LOANS.map((t) => buildServicerRecord(t));
    const counts = (recs: ServicerRecord[], p: PresetId) => countStatuses(recs.map((r) => evaluate(r, S(), p, DEMO_AS_OF)));
    expect(counts(twelve, "standard")).toEqual({ ready: 2, watch: 3, notyet: 6, reconnect: 1, missing: 0 });
    expect(counts(twelve, "va")).toEqual({ ready: 3, watch: 2, notyet: 6, reconnect: 1, missing: 0 });
    expect(counts(twelve, "fha")).toEqual({ ready: 2, watch: 3, notyet: 6, reconnect: 1, missing: 0 });
    expect(counts(demoRecords(), "standard")).toEqual({ ready: 3, watch: 3, notyet: 6, reconnect: 1, missing: 0 });
  });

  it("only Katie Brooks (VA, fixed) changes status when the VA preset is picked", () => {
    const recs = demoRecords();
    const std = recs.map((r) => evaluate(r, S(), "standard", DEMO_AS_OF).status);
    const va = recs.map((r) => evaluate(r, S(), "va", DEMO_AS_OF).status);
    const changed = recs.filter((_, i) => std[i] !== va[i]).map((r) => r.id);
    expect(changed).toEqual(["L05"]);
  });
});

describe("edge cases (from math_check.mjs)", () => {
  const base = makeRecord({ id: "E1", P: 300000, rate: 7.5, n: 360, orig: "2023-06-15" });
  const SE = S({ closingCosts: 9000, minSavings: 100 });
  const eBase = expected(base, SE);
  if (!eBase.complete) throw new Error("edge base must evaluate");
  const savings = eBase.savings;
  const payback = eBase.payback as number;
  const drop = eBase.drop;

  it("base loan passes rate and payback, payback at least 13 months", () => {
    expect(eBase.status).toBe("ready");
    expect(payback).toBeGreaterThanOrEqual(13);
  });
  const cases: Array<[string, Partial<RuleSettings>, string]> = [
    ["savings exactly $50 under the minimum is Watch", { minSavings: savings + 50 }, "watch"],
    ["savings $50.01 under the minimum is Not yet", { minSavings: savings + 50.01 }, "notyet"],
    ["payback exactly 12 months over the max is Watch", { maxPayback: payback - 12 }, "watch"],
    ["payback 13 months over the max is Not yet", { maxPayback: payback - 13 }, "notyet"],
    ["rate drop exactly 0.25 short is Watch", { minDrop: drop + 0.25 }, "watch"],
    ["rate drop 0.251 short is Not yet", { minDrop: drop + 0.251 }, "notyet"],
  ];
  for (const [name, over, want] of cases) {
    it(name, () => {
      const s = { ...SE, ...over };
      expect(ev(base, s).status).toBe(want);
      expect(expected(base, s).status).toBe(want);
    });
  }
  it("a loan below today's rate is never Watch, even when savings and payback pass on a 30-year term", () => {
    const below = makeRecord({ id: "E2", P: 300000, rate: 6.0, n: 180, orig: "2025-01-10" });
    const s = S({ minDrop: 0.125, newTerm: "360" });
    const r = ev(below, s);
    expect(r.status).toBe("notyet");
    expect(reasonText(r)).toMatch(/below today's rate/);
    expect(r.savings).toBeGreaterThan(150);
    expect(r.paybackMonths).not.toBeNull();
  });
  it("closed on Jan 31: 9 months since closing on Nov 9, held for 10 months until Dec 1, 2026", () => {
    const c31 = makeRecord({ id: "E3", P: 400000, rate: 7.5, n: 360, orig: "2026-01-31" });
    const r = ev(c31, S({ minSeasoning: 10 }));
    expect(r.status).toBe("notyet");
    expect(r.monthsSinceClosing).toBe(9);
    expect(r.eligibleDate).toBe("2026-12-01");
    expect(monthsSince("2026-01-31", "2026-11-30")).toBe(9);
    expect(monthsSince("2026-01-31", "2026-12-01")).toBe(10);
  });
  it("a matured loan (no payments left) shows At maturity and is never Ready", () => {
    const matured = { ...base, id: "E4", next_payment_due_date: "2026-12-01", maturity_date: "2026-11-01" };
    const r = ev(matured);
    expect(r.status).toBe("notyet");
    expect(r.paymentsLeft).toBe(0);
    expect(r.atMaturity).toBe(true);
    expect(Number.isNaN(r.newPI)).toBe(true);
    expect(reasonText(r)).toMatch(/At maturity/);
  });

  const NULLS: Array<[string, string]> = [
    ["current_balance", "current balance"],
    ["interest_rate.percentage", "interest rate"],
    ["maturity_date", "maturity date"],
    ["next_payment_due_date", "next due date"],
    ["origination_date", "origination date"],
    ["origination_principal_amount", "original amount"],
    ["loan_term", "loan term"],
  ];
  for (const [k, label] of NULLS) {
    it(`null ${k} gives Missing data, names "${label}", never guessed, blocks Ready`, () => {
      const rec = JSON.parse(JSON.stringify(base)) as ServicerRecord & Record<string, unknown>;
      if (k === "interest_rate.percentage") rec.interest_rate.percentage = null;
      else rec[k] = null;
      const r = ev(rec);
      expect(r.status).toBe("missing");
      expect(reasonText(r)).toBe(`Not reported by the servicer: ${label}. Not checked against your rule.`);
      expect(Number.isNaN(r.savings)).toBe(true);
    });
  }
  it("a missing rate type is Missing data too", () => {
    const rec = { ...base, interest_rate: { percentage: 7.5, type: null } };
    expect(ev(rec).status).toBe("missing");
  });
  it("a reconnect loan with a missing field stays Reconnect", () => {
    const rec = { ...base, connection: "login_required" as const, current_balance: null };
    expect(ev(rec).status).toBe("reconnect");
  });
});

describe("sanitizeSettings", () => {
  it("accepts valid settings and numeric strings", () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, todayRate: "6.25" })).toEqual({ ...DEFAULT_SETTINGS, todayRate: 6.25 });
  });
  it("rejects missing or out-of-range values", () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, todayRate: -1 })).toBeNull();
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, newTerm: "15" })).toBeNull();
    expect(sanitizeSettings(null)).toBeNull();
  });
});
