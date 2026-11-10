/**
 * Refi Watch rule engine.
 *
 * A straight port of the demo's math (demo/index.html, the RefiWatch object:
 * monthlyPI, balanceAfter, scheduledInterest, evaluate, reasonText). Pure and
 * isomorphic: no I/O, no clock. "Today" is always passed in as `asOf`, so the
 * same inputs give the same answer on the server, in the browser and in tests.
 *
 * Rules carried over from the demo:
 * - Current P&I, fixed rate: the scheduled payment from the original amount,
 *   note rate and original term. ARM: the balance at the note rate over the
 *   payments left.
 * - Payments left: from the next due date to the maturity date, both counted.
 * - New P&I: the current balance at today's rate over the remaining term
 *   (default) or a new 30-year term. The other one is shown separately.
 * - Savings: current P&I minus new P&I. P&I only, never escrow.
 * - Payback: closing costs divided by savings, rounded up.
 * - A missing field is shown as missing, never guessed, and blocks Ready.
 */

export type RateType = "fixed" | "variable";
export type Connection = "ok" | "login_required" | "pending_expiration" | "error";
export type Status = "ready" | "watch" | "notyet" | "reconnect" | "missing";
export type NewTerm = "keep" | "360";
export type PresetId = "standard" | "va" | "fha";
export type MoneyLine = "rate" | "savings" | "payback";

/** The fields a servicer reports through Plaid, limited to what Refi Watch stores. */
export interface ServicerRecord {
  id: string;
  borrower: string;
  email?: string | null;
  /** Servicer or institution name, as Plaid reports it. */
  servicer: string;
  connection: Connection;
  /** ISO timestamp of the last good update from Plaid. */
  lastUpdated?: string | null;
  isNew?: boolean;
  interest_rate: { percentage: number | null; type: string | null };
  current_balance: number | null;
  next_monthly_payment: number | null;
  next_payment_due_date: string | null;
  origination_date: string | null;
  origination_principal_amount: number | null;
  maturity_date: string | null;
  loan_term: string | null;
  loan_type_description: string | null;
  /** Last 4 of the loan number only. */
  mask: string | null;
}

export interface RuleSettings {
  /** Today's rate Michael can offer (30-year fixed, conventional), in percent. */
  todayRate: number;
  closingCosts: number;
  minDrop: number;
  minSavings: number;
  maxPayback: number;
  minSeasoning: number;
  newTerm: NewTerm;
  rollCosts: boolean;
}

/** Michael's default rule. Same values as the demo's DEFAULTS. */
export const DEFAULT_SETTINGS: Readonly<RuleSettings> = Object.freeze({
  todayRate: 6.125,
  closingCosts: 4000,
  minDrop: 0.75,
  minSavings: 150,
  maxPayback: 36,
  minSeasoning: 6,
  newTerm: "keep",
  rollCosts: false,
});

export const THRESHOLD_KEYS = ["minDrop", "minSavings", "maxPayback", "minSeasoning"] as const;

/** Watch: one money line misses, but by no more than this. */
export const WATCH_MARGIN = Object.freeze({ rate: 0.25, savings: 50, payback: 12 });

/** Tolerance for floating point comparisons. */
export const EPS = 1e-9;

export interface Preset {
  label: string;
  short: string;
  appliesTo: "VA" | "FHA" | null;
  values: Partial<Pick<RuleSettings, "minDrop" | "minSavings" | "maxPayback" | "minSeasoning">>;
  why?: string;
  note: string;
}

/** A preset applies only to fixed-rate loans of its own type. Every other loan keeps Michael's rule. */
export const PRESETS: Readonly<Record<PresetId, Preset>> = Object.freeze({
  standard: { label: "Standard: your rule only", short: "Your rule", appliesTo: null, values: {}, note: "" },
  va: {
    label: "VA streamline starting point",
    short: "VA starting point",
    appliesTo: "VA",
    why: "Why 9 months",
    values: { minDrop: 0.5, maxPayback: 36, minSeasoning: 9 },
    note: "VA loans only. Starting point. Confirm against current VA guidelines. Fixed to fixed: rate at least 0.50 lower, costs paid back within 36 months, and 9 months since closing. VA counts 210 days from the first payment due date, plus 6 payments in a row, and 9 months covers that for any closing day.",
  },
  fha: {
    label: "FHA streamline starting point",
    short: "FHA starting point",
    appliesTo: "FHA",
    why: "Why 8 months",
    values: { minDrop: 0.5, minSeasoning: 8 },
    note: "FHA loans only. Starting point. Confirm against current FHA guidelines. Rate at least 0.50 lower and 8 months since closing. HUD needs 210 days since closing, 6 payments and 6 full months since the first payment due date, and 8 months covers that for any closing day. HUD compares the rate plus annual MIP. Plaid doesn't report MIP, so this checks the note rate only.",
  },
});

/* ---------------------------------------------------------------------------
   Dates. Plain {y, m, d} so nothing depends on the server's time zone.
   ------------------------------------------------------------------------- */

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export function parseDate(s: string): YMD {
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m, d };
}
export function isoDate(dt: YMD): string {
  return `${dt.y}-${String(dt.m).padStart(2, "0")}-${String(dt.d).padStart(2, "0")}`;
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthIndex(dt: YMD): number {
  return dt.y * 12 + (dt.m - 1);
}
export function cmpDate(a: YMD, b: YMD): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}
export function addMonths(dt: YMD, k: number): YMD {
  const idx = monthIndex(dt) + k;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(dt.d, daysInMonth(y, m)) };
}
/** Whole months from date a to date b. */
export function wholeMonthsBetween(a: YMD | string, b: YMD | string): number {
  const A = typeof a === "string" ? parseDate(a) : a;
  const B = typeof b === "string" ? parseDate(b) : b;
  return (B.y - A.y) * 12 + (B.m - A.m) - (B.d < A.d ? 1 : 0);
}

/** Today's date (YYYY-MM-DD) in a time zone. Weber Mortgage is in Alabama, so Central time by default. */
export function todayISO(timeZone = "America/Chicago", now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/* ---------------------------------------------------------------------------
   Payment math
   ------------------------------------------------------------------------- */

/** Monthly principal and interest: M = P*r / (1 - (1+r)^-n), r = annual rate / 100 / 12. NaN when there are no payments. */
export function monthlyPI(P: number, annualRate: number, n: number): number {
  if (!(n > 0)) return NaN;
  const r = annualRate / 100 / 12;
  if (r === 0) return P / n;
  return (P * r) / (1 - Math.pow(1 + r, -n));
}

/** Balance after k scheduled payments. */
export function balanceAfter(P: number, annualRate: number, n: number, k: number): number {
  const r = annualRate / 100 / 12;
  const M = monthlyPI(P, annualRate, n);
  let b = P;
  for (let j = 1; j <= k; j++) b -= M - b * r;
  return b;
}

/** Sum of the interest in every remaining scheduled payment. */
export function scheduledInterest(P: number, annualRate: number, n: number): number {
  if (!(n > 0) || !(P > 0)) return 0;
  const r = annualRate / 100 / 12;
  const M = monthlyPI(P, annualRate, n);
  let b = P;
  let total = 0;
  for (let j = 0; j < n; j++) {
    const i = b * r;
    total += i;
    b -= M - i;
  }
  return total;
}

/** First payment due date: the 1st of the second month after closing. */
export function firstDueDate(orig: YMD): YMD {
  return addMonths({ y: orig.y, m: orig.m, d: 1 }, 2);
}
/** Payments made by a date, counted from the first payment due date. */
export function paymentsMadeBy(firstDue: YMD, asOf: YMD): number {
  return cmpDate(asOf, firstDue) < 0 ? 0 : wholeMonthsBetween(firstDue, asOf) + 1;
}
/** Payments left: from the next due date to the maturity date, counting both. */
export function paymentsLeftBetween(nextDue: YMD, maturity: YMD): number {
  return cmpDate(nextDue, maturity) > 0 ? 0 : wholeMonthsBetween(nextDue, maturity) + 1;
}
/** Loan term in months from the servicer's loan_term text ("30 year", "180 month"). */
export function termMonthsOf(t: unknown): number {
  if (typeof t === "number") return Number.isFinite(t) && t > 0 ? t : NaN;
  if (typeof t !== "string") return NaN;
  const m = t.match(/(\d+(?:\.\d+)?)\s*(year|yr|month|mo)/i);
  if (!m) return NaN;
  return /^m/i.test(m[2]) ? Math.round(Number(m[1])) : Math.round(Number(m[1]) * 12);
}
export const round2 = (x: number): number => Math.round(x * 100) / 100;

/* ---------------------------------------------------------------------------
   The rule. Pure: (servicer record, settings, preset, asOf) -> result.
   ------------------------------------------------------------------------- */

export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function missingFields(rec: ServicerRecord): string[] {
  const ir = rec.interest_rate || { percentage: null, type: null };
  const miss: string[] = [];
  if (!isNum(rec.current_balance)) miss.push("current balance");
  if (!isNum(ir.percentage)) miss.push("interest rate");
  if (ir.type !== "fixed" && ir.type !== "variable") miss.push("rate type");
  if (!isDate(rec.maturity_date)) miss.push("maturity date");
  if (!isDate(rec.next_payment_due_date)) miss.push("next due date");
  if (!isDate(rec.origination_date)) miss.push("origination date");
  // Original amount and loan term are not required: if the servicer doesn't report them, the current
  // P&I is calculated from the servicer's current balance, rate and payments left instead (see evaluate).
  return miss;
}

/** True when a fixed-rate loan has what's needed for the scheduled payment on the note. */
export function hasNoteTerms(rec: ServicerRecord): boolean {
  return isNum(rec.origination_principal_amount) && rec.origination_principal_amount > 0 && termMonthsOf(rec.loan_term) > 0;
}

export const PI_FROM_BALANCE_NOTE =
  "Current P&I calculated from the servicer's current balance, rate and payments left (original amount or term not reported).";

export function loanKind(rec: Pick<ServicerRecord, "loan_type_description">): "VA" | "FHA" | null {
  const d = String(rec.loan_type_description || "");
  if (/\bVA\b/i.test(d)) return "VA";
  if (/\bFHA\b/i.test(d)) return "FHA";
  return null;
}

/** Which rule a loan is checked against. */
export function ruleFor(
  rec: ServicerRecord,
  s: RuleSettings,
  presetId: PresetId,
): { key: PresetId; name: string; s: RuleSettings } {
  const p = PRESETS[presetId];
  if (p && p.appliesTo && loanKind(rec) === p.appliesTo && rec.interest_rate && rec.interest_rate.type === "fixed") {
    return { key: presetId, name: p.short, s: { ...s, ...p.values } };
  }
  return { key: "standard", name: "Your rule", s: { ...s } };
}

export interface RuleTests {
  rate: boolean;
  savings: boolean;
  payback: boolean;
  seasoning: boolean;
  connection: boolean;
}

export interface RuleResult {
  id: string;
  borrower: string;
  servicer: string;
  rule: PresetId;
  ruleName: string;
  /** The settings actually used for this loan (preset applied). */
  s: RuleSettings;
  connectionOk: boolean;
  rateType: string | null;
  status: Status;
  missing: string[];
  rate: number;
  balance: number;
  paymentsLeft: number;
  monthsSinceClosing: number;
  currentPI: number;
  newTermMonths: number;
  newPrincipal: number;
  newPI: number;
  savings: number;
  paybackMonths: number | null;
  rateDrop: number;
  interestLeftCurrent: number;
  interestLeftNew: number;
  newPI30: number;
  newPIKeep: number;
  interestNew30: number;
  interestNewKeep: number;
  atMaturity: boolean;
  tests: Partial<RuleTests>;
  failedMoney: MoneyLine[];
  watchLine: MoneyLine | null;
  heldForSeasoning: boolean;
  eligibleDate: string | null;
  notes: string[];
}

export const ARM_NOTE = "ARM: check the next rate adjustment date.";

export function evaluate(
  rec: ServicerRecord,
  settingsIn: RuleSettings,
  presetId: PresetId = "standard",
  asOfIso: string,
): RuleResult {
  if (!isDate(asOfIso)) throw new Error("evaluate: asOf must be YYYY-MM-DD");
  const rule = ruleFor(rec, settingsIn, presetId || "standard");
  const s = rule.s;
  const asOf = parseDate(asOfIso);
  const connectionOk = rec.connection === "ok";
  const ir = rec.interest_rate || { percentage: null, type: null };
  const base = {
    id: rec.id,
    borrower: rec.borrower,
    servicer: rec.servicer,
    rule: rule.key,
    ruleName: rule.name,
    s,
    connectionOk,
    rateType: ir.type || null,
  };
  const missing = missingFields(rec);
  if (missing.length) {
    return {
      ...base,
      status: connectionOk ? "missing" : "reconnect",
      missing,
      rate: isNum(ir.percentage) ? ir.percentage : NaN,
      balance: isNum(rec.current_balance) ? rec.current_balance : NaN,
      paymentsLeft: NaN,
      monthsSinceClosing: NaN,
      currentPI: NaN,
      newTermMonths: NaN,
      newPrincipal: NaN,
      newPI: NaN,
      savings: NaN,
      paybackMonths: null,
      rateDrop: NaN,
      interestLeftCurrent: NaN,
      interestLeftNew: NaN,
      newPI30: NaN,
      newPIKeep: NaN,
      interestNew30: NaN,
      interestNewKeep: NaN,
      atMaturity: false,
      tests: {},
      failedMoney: [],
      watchLine: null,
      heldForSeasoning: false,
      eligibleDate: null,
      notes: [],
    };
  }
  // missingFields() guarantees these are present.
  const rate = ir.percentage as number;
  const balance = rec.current_balance as number;
  const fixed = ir.type === "fixed";
  const orig = parseDate(rec.origination_date as string);
  const paymentsLeft = paymentsLeftBetween(parseDate(rec.next_payment_due_date as string), parseDate(rec.maturity_date as string));
  const monthsSinceClosing = Math.max(0, wholeMonthsBetween(orig, asOf));
  const fromNote = fixed && hasNoteTerms(rec);
  // Fixed rate: the scheduled payment on the note. ARM, or a fixed loan whose servicer doesn't report the
  // original amount or term: the current balance at the note rate over the payments left.
  const currentPI = fromNote
    ? monthlyPI(rec.origination_principal_amount as number, rate, termMonthsOf(rec.loan_term))
    : monthlyPI(balance, rate, paymentsLeft);
  const atMaturity = paymentsLeft === 0;
  const newTermMonths = s.newTerm === "360" ? 360 : paymentsLeft;
  const newPrincipal = balance + (s.rollCosts ? s.closingCosts : 0);
  const newPI = monthlyPI(newPrincipal, s.todayRate, newTermMonths);
  const savings = currentPI - newPI;
  let paybackMonths: number | null = savings > 0 ? Math.max(0, Math.ceil(s.closingCosts / savings - EPS)) : null;
  if (paybackMonths !== null && paybackMonths > Math.min(paymentsLeft, newTermMonths)) paybackMonths = null;
  const rateDrop = rate - s.todayRate;
  const interestLeftCurrent = scheduledInterest(balance, rate, paymentsLeft);
  const interestNewKeep = scheduledInterest(newPrincipal, s.todayRate, paymentsLeft);
  const interestNew30 = scheduledInterest(newPrincipal, s.todayRate, 360);
  const interestLeftNew = newTermMonths === 360 ? interestNew30 : interestNewKeep;
  const newPI30 = monthlyPI(newPrincipal, s.todayRate, 360);
  const newPIKeep = monthlyPI(newPrincipal, s.todayRate, paymentsLeft);
  const tests: RuleTests = {
    rate: rateDrop >= s.minDrop - EPS,
    savings: savings >= s.minSavings - EPS,
    payback: paybackMonths !== null && paybackMonths <= s.maxPayback + EPS,
    seasoning: monthsSinceClosing >= s.minSeasoning - EPS,
    connection: connectionOk,
  };
  const failedMoney = (["rate", "savings", "payback"] as const).filter((k) => !tests[k]);
  let watchLine: MoneyLine | null = null;
  if (failedMoney.length === 1 && !atMaturity) {
    const f = failedMoney[0];
    const near =
      f === "rate"
        ? rateDrop > EPS && rateDrop >= s.minDrop - WATCH_MARGIN.rate - EPS
        : f === "savings"
          ? savings > 0 && savings >= s.minSavings - WATCH_MARGIN.savings - EPS
          : paybackMonths !== null && paybackMonths <= s.maxPayback + WATCH_MARGIN.payback + EPS;
    if (near) watchLine = f;
  }
  let status: Status;
  if (!connectionOk) status = "reconnect";
  else if (atMaturity) status = "notyet";
  else if (failedMoney.length === 0 && tests.seasoning) status = "ready";
  else if (tests.seasoning && watchLine) status = "watch";
  else status = "notyet";
  const heldForSeasoning = !atMaturity && failedMoney.length === 0 && !tests.seasoning;
  let eligibleDate: string | null = null;
  if (heldForSeasoning) {
    const k = Math.ceil(s.minSeasoning - EPS);
    let e = addMonths(orig, k);
    if (wholeMonthsBetween(orig, e) < k) e = addMonths({ y: e.y, m: e.m, d: 1 }, 1);
    eligibleDate = isoDate(e);
  }
  const notes = ir.type === "variable" ? [ARM_NOTE] : fromNote ? [] : [PI_FROM_BALANCE_NOTE];
  return {
    ...base,
    missing: [],
    rate,
    balance,
    paymentsLeft,
    monthsSinceClosing,
    currentPI,
    newTermMonths,
    newPrincipal,
    newPI,
    savings,
    paybackMonths,
    rateDrop,
    interestLeftCurrent,
    interestLeftNew,
    newPI30,
    newPIKeep,
    interestNew30,
    interestNewKeep,
    atMaturity,
    tests,
    failedMoney: [...failedMoney],
    watchLine,
    status,
    heldForSeasoning,
    eligibleDate,
    notes,
  };
}

export type StatusCounts = Record<Status, number>;

export function countStatuses(rs: Pick<RuleResult, "status">[]): StatusCounts {
  const c: StatusCounts = { ready: 0, watch: 0, notyet: 0, reconnect: 0, missing: 0 };
  rs.forEach((r) => {
    c[r.status]++;
  });
  return c;
}

export const STATUS_LABEL: Readonly<Record<Status, string>> = Object.freeze({
  ready: "Ready",
  watch: "Watch",
  notyet: "Not yet",
  reconnect: "Reconnect needed",
  missing: "Missing data",
});

/* ---------------------------------------------------------------------------
   Number formats used by the reason text (same as the demo).
   ------------------------------------------------------------------------- */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const NR = "Not reported";
export const money = (x: number | null | undefined): string => (isNum(x) ? USD.format(Math.abs(x) < 0.005 ? 0 : x) : NR);
export const money0 = (x: number): string => USD0.format(Math.abs(x) < 0.5 ? 0 : x);
export const moneyThr = (x: number): string => (Number.isInteger(x) ? money0(x) : money(x));
export const pct = (x: number | null | undefined): string => (isNum(x) ? x.toFixed(3) + "%" : NR);
export const pts = (x: number): string => Math.abs(x).toFixed(3);
export const thr = (x: number): string => {
  const s = (Math.round(x * 1000) / 1000).toString();
  const [a, b = ""] = s.split(".");
  return a + "." + (b + "00").slice(0, Math.max(2, b.length));
};
export const intish = (x: number): string => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100));
export const plural = (n: number, w: string): string => (n === 1 ? w : w + "s");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (iso: string | null | undefined): string => {
  if (!isDate(iso)) return NR;
  const d = parseDate(iso);
  return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`;
};

/** Status reason, one short line. It names the rule used. */
export function reasonText(r: RuleResult): string {
  if (r.missing.length) return `Not reported by the servicer: ${r.missing.join(", ")}. Not checked against your rule.`;
  if (r.status === "reconnect") return "Borrower needs to reconnect through Plaid";
  if (r.atMaturity) return "At maturity. No payments left.";
  const R = r.ruleName;
  const s = r.s;
  if (r.status === "ready") return `${R}: passes all 4 lines`;
  if (r.heldForSeasoning) return `${R}: ${r.monthsSinceClosing} of ${intish(s.minSeasoning)} months since closing`;
  const f = r.status === "watch" ? r.watchLine : r.failedMoney[0] || null;
  if (!f) return `${R}: ${r.monthsSinceClosing} of ${intish(s.minSeasoning)} months since closing`;
  if (f === "rate")
    return r.rateDrop < -EPS
      ? `${R}: below today's rate`
      : r.rateDrop <= EPS
        ? `${R}: same as today's rate`
        : `${R}: rate ${pts(r.rateDrop)} lower, needs ${thr(s.minDrop)}`;
  if (f === "savings")
    return r.savings <= 0 ? `${R}: new payment is higher` : `${R}: saves ${money(r.savings)}, needs ${moneyThr(s.minSavings)}`;
  return r.paybackMonths === null ? `${R}: no payback` : `${R}: payback ${r.paybackMonths} mo, needs ${intish(s.maxPayback)}`;
}

/** Clamp and validate settings coming from a form or the database. Returns null for anything invalid. */
export function sanitizeSettings(input: unknown): RuleSettings | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const num = (k: string, min: number, max: number): number | null => {
    const v = typeof o[k] === "string" ? Number(o[k]) : o[k];
    return isNum(v) && v >= min && v <= max ? v : null;
  };
  const todayRate = num("todayRate", 0, 25);
  const closingCosts = num("closingCosts", 0, 1_000_000);
  const minDrop = num("minDrop", 0, 10);
  const minSavings = num("minSavings", 0, 100_000);
  const maxPayback = num("maxPayback", 0, 600);
  const minSeasoning = num("minSeasoning", 0, 600);
  const newTerm = o.newTerm === "360" ? "360" : o.newTerm === "keep" ? "keep" : null;
  const rollCosts = typeof o.rollCosts === "boolean" ? o.rollCosts : null;
  if ([todayRate, closingCosts, minDrop, minSavings, maxPayback, minSeasoning, newTerm, rollCosts].some((v) => v === null)) return null;
  return {
    todayRate: todayRate as number,
    closingCosts: closingCosts as number,
    minDrop: minDrop as number,
    minSavings: minSavings as number,
    maxPayback: maxPayback as number,
    minSeasoning: minSeasoning as number,
    newTerm: newTerm as NewTerm,
    rollCosts: rollCosts as boolean,
  };
}

export const isPresetId = (x: unknown): x is PresetId => x === "standard" || x === "va" || x === "fha";
