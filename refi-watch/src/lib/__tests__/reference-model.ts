/**
 * Independent reference model, mirrored from demo/math_check.mjs (lines ~39-151).
 * Written separately from rules.ts on purpose: it walks the payment schedule with
 * Date.UTC and uses closed forms for payments and balances. Tests compare the
 * engine against it so a bug in one shows up as a mismatch.
 */
import type { ServicerRecord } from "../rules";

export const AS_OF = "2026-11-09";
const EPS = 1e-9;
const ms = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export function monthsSince(fromIso: string, toIso: string): number {
  const [y, m, d] = fromIso.split("-").map(Number);
  const end = ms(toIso);
  let k = 0;
  while (Date.UTC(y, m - 1 + k + 1, d) <= end) k++;
  return k;
}
function dueDates(origIso: string, n: number): string[] {
  const [y, m] = origIso.split("-").map(Number);
  const out: string[] = [];
  for (let j = 0; j < n; j++) out.push(isoOf(Date.UTC(y, m - 1 + 2 + j, 1)));
  return out;
}
export function payment(P: number, annual: number, n: number): number {
  if (!(n > 0)) return NaN;
  const r = annual / 1200;
  if (r === 0) return P / n;
  return (P * r) / -Math.expm1(-n * Math.log1p(r));
}
function balanceClosed(P: number, annual: number, n: number, k: number): number {
  const r = annual / 1200;
  const M = payment(P, annual, n);
  if (r === 0) return P - M * k;
  const g = Math.pow(1 + r, k);
  return P * g - (M * (g - 1)) / r;
}
const interestLeft = (P: number, annual: number, n: number) => (!(n > 0) || !(P > 0) ? 0 : payment(P, annual, n) * n - P);
export function countPayments(nextIso: string, matIso: string): number {
  if (ms(nextIso) > ms(matIso)) return 0;
  const [y, m] = nextIso.split("-").map(Number);
  let k = 0;
  while (Date.UTC(y, m - 1 + k, 1) <= ms(matIso)) k++;
  return k;
}

export interface MakeRecordInput {
  id?: string;
  borrower?: string;
  servicer?: string;
  P: number;
  rate: number;
  n: number;
  orig: string;
  type?: string;
  rateType?: "fixed" | "variable";
  escrow?: number;
  asOf?: string;
  connection?: ServicerRecord["connection"];
  mask?: string;
}

export function makeRecord(i: MakeRecordInput): ServicerRecord & { _made: number } {
  const { id = "X", borrower = "Test Person", servicer = "Rocket Mortgage", P, rate, n, orig, type = "Conventional", rateType = "fixed", escrow = 300, asOf = AS_OF, connection = "ok", mask = "0000" } = i;
  const dates = dueDates(orig, n);
  const made = dates.filter((d) => ms(d) <= ms(asOf)).length;
  return {
    id,
    borrower,
    email: "x@example.com",
    servicer,
    connection,
    interest_rate: { percentage: rate, type: rateType },
    current_balance: Math.round(balanceClosed(P, rate, n, made) * 100) / 100,
    next_monthly_payment: Math.round((Math.round(payment(P, rate, n) * 100) / 100 + escrow) * 100) / 100,
    next_payment_due_date: dates[made],
    origination_date: orig,
    origination_principal_amount: P,
    maturity_date: dates[n - 1],
    loan_term: n / 12 + " year",
    loan_type_description: type,
    mask,
    _made: made,
  };
}

const WATCH = { rate: 0.25, savings: 50, payback: 12 };
const PRESET_VALUES: Record<string, Record<string, number>> = {
  va: { minDrop: 0.5, maxPayback: 36, minSeasoning: 9 },
  fha: { minDrop: 0.5, minSeasoning: 8 },
};
export interface RefSettings {
  todayRate: number;
  closingCosts: number;
  minDrop: number;
  minSavings: number;
  maxPayback: number;
  minSeasoning: number;
  newTerm: "keep" | "360";
  rollCosts: boolean;
}
function effective(rec: ServicerRecord, s: RefSettings, preset: string) {
  const want = preset === "va" ? "VA" : preset === "fha" ? "FHA" : null;
  const words = String(rec.loan_type_description || "").toUpperCase().split(/[^A-Z]+/);
  if (want && words.includes(want) && rec.interest_rate.type === "fixed")
    return { name: preset === "va" ? "VA starting point" : "FHA starting point", s: { ...s, ...PRESET_VALUES[preset] } as RefSettings };
  return { name: "Your rule", s };
}
const nullish = (x: unknown) => x === null || x === undefined || (typeof x === "number" && !Number.isFinite(x));

export function expected(rec: ServicerRecord, sIn: RefSettings, preset = "standard", asOf = AS_OF) {
  const { name, s } = effective(rec, sIn, preset);
  const ir = rec.interest_rate || ({} as ServicerRecord["interest_rate"]);
  const miss: string[] = [];
  if (nullish(rec.current_balance)) miss.push("current balance");
  if (nullish(ir.percentage)) miss.push("interest rate");
  if (!["fixed", "variable"].includes(String(ir.type))) miss.push("rate type");
  if (nullish(rec.maturity_date)) miss.push("maturity date");
  if (nullish(rec.next_payment_due_date)) miss.push("next due date");
  if (nullish(rec.origination_date)) miss.push("origination date");
  if (ir.type === "fixed" && nullish(rec.origination_principal_amount)) miss.push("original amount");
  if (ir.type === "fixed" && nullish(rec.loan_term)) miss.push("loan term");
  if (miss.length) return { complete: false as const, status: rec.connection === "ok" ? "missing" : "reconnect", missing: miss, ruleName: name };
  const rate = ir.percentage as number;
  const bal = rec.current_balance as number;
  const left = countPayments(rec.next_payment_due_date as string, rec.maturity_date as string);
  const since = monthsSince(rec.origination_date as string, asOf);
  const noteN = parseInt(rec.loan_term as string, 10) * 12;
  const currentPI = ir.type === "fixed" ? payment(rec.origination_principal_amount as number, rate, noteN) : payment(bal, rate, left);
  const newN = s.newTerm === "360" ? 360 : left;
  const newP = bal + (s.rollCosts ? s.closingCosts : 0);
  const newPI = payment(newP, s.todayRate, newN);
  const savings = currentPI - newPI;
  let payback: number | null = savings > 0 ? Math.ceil(s.closingCosts / savings - EPS) : null;
  if (payback !== null && payback > Math.min(left, newN)) payback = null;
  const drop = rate - s.todayRate;
  const pass = {
    rate: drop >= s.minDrop - EPS,
    savings: savings >= s.minSavings - EPS,
    payback: payback !== null && payback <= s.maxPayback + EPS,
    season: since >= s.minSeasoning - EPS,
  };
  const fails = (["rate", "savings", "payback"] as const).filter((k) => !pass[k]);
  const nearOne =
    fails.length === 1 &&
    {
      rate: drop > EPS && drop >= s.minDrop - WATCH.rate - EPS,
      savings: savings > 0 && savings >= s.minSavings - WATCH.savings - EPS,
      payback: payback !== null && payback <= s.maxPayback + WATCH.payback + EPS,
    }[fails[0]];
  let status: string;
  if (rec.connection !== "ok") status = "reconnect";
  else if (left === 0) status = "notyet";
  else if (!fails.length && pass.season) status = "ready";
  else if (pass.season && nearOne) status = "watch";
  else status = "notyet";
  return {
    complete: true as const,
    status,
    ruleName: name,
    missing: [] as string[],
    left,
    since,
    currentPI,
    newN,
    newP,
    newPI,
    savings,
    payback,
    drop,
    interestLeftCurrent: interestLeft(bal, rate, left),
    interestLeftNew: interestLeft(newP, s.todayRate, newN),
    interestNew30: interestLeft(newP, s.todayRate, 360),
    interestNewKeep: interestLeft(newP, s.todayRate, left),
  };
}
