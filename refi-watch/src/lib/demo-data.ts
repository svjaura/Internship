/**
 * The demo's 13 test loans (fictional people), used when no keys are set.
 *
 * Each loan is an original amount, a note rate, a term and a closing date.
 * The servicer fields are built from those by the payment schedule, exactly
 * as the demo's buildServicerRecord() does, as of the demo date (Mon Nov 9, 2026).
 * escrowMonthly only feeds the servicer's monthly payment; it is not stored.
 */
import {
  addMonths,
  balanceAfter,
  firstDueDate,
  isoDate,
  monthlyPI,
  parseDate,
  paymentsMadeBy,
  round2,
  type Connection,
  type RateType,
  type ServicerRecord,
} from "./rules";

/** The demo's fixed "today". Demo numbers only match when evaluated as of this date. */
export const DEMO_AS_OF = "2026-11-09";

export const DEMO_SERVICERS: Record<string, string> = {
  mrcooper: "Mr. Cooper",
  rocket: "Rocket Mortgage",
  pennymac: "Pennymac",
  chase: "JPMorgan Chase Bank",
  wells: "Wells Fargo Home Mortgage",
  freedom: "Freedom Mortgage",
  bofa: "Bank of America",
  shellpoint: "Shellpoint Mortgage Servicing",
};

export interface TestLoan {
  id: string;
  borrower: string;
  email: string;
  servicer: keyof typeof DEMO_SERVICERS;
  loanType: string;
  rateType: RateType;
  rate: number;
  originalAmount: number;
  originationDate: string;
  termMonths: number;
  escrowMonthly: number;
  last4: string;
  asOf?: string;
  connection?: Connection;
  lastGoodUpdate?: string;
}

export const TEST_LOANS: readonly TestLoan[] = [
  { id: "L01", borrower: "Dana Whitfield", email: "dana.whitfield@example.com", servicer: "chase", loanType: "Conventional", rateType: "fixed", rate: 7.875, originalAmount: 342000, originationDate: "2023-10-06", termMonths: 360, escrowMonthly: 412.36, last4: "4417" },
  { id: "L02", borrower: "Priya Raman", email: "priya.raman@example.com", servicer: "pennymac", loanType: "Conventional", rateType: "fixed", rate: 7.125, originalAmount: 415000, originationDate: "2023-12-04", termMonths: 360, escrowMonthly: 468.15, last4: "1186" },
  { id: "L03", borrower: "Marcus Bell", email: "marcus.bell@example.com", servicer: "rocket", loanType: "FHA", rateType: "fixed", rate: 6.875, originalAmount: 268000, originationDate: "2025-02-07", termMonths: 360, escrowMonthly: 441.24, last4: "9032" },
  { id: "L04", borrower: "Luis Ortega", email: "luis.ortega@example.com", servicer: "wells", loanType: "Conventional", rateType: "variable", rate: 6.625, originalAmount: 438000, originationDate: "2023-08-04", termMonths: 360, escrowMonthly: 497.8, last4: "3361" },
  { id: "L05", borrower: "Katie Brooks", email: "katie.brooks@example.com", servicer: "bofa", loanType: "VA", rateType: "fixed", rate: 6.75, originalAmount: 445000, originationDate: "2023-11-03", termMonths: 360, escrowMonthly: 356.12, last4: "5508" },
  { id: "L06", borrower: "Andrea Kim", email: "andrea.kim@example.com", servicer: "wells", loanType: "FHA", rateType: "fixed", rate: 7.25, originalAmount: 165000, originationDate: "2023-10-02", termMonths: 360, escrowMonthly: 287.65, last4: "6613" },
  // Reconnect loan: built as of its last good update, Tue Nov 3.
  { id: "L07", borrower: "Michelle Dunn", email: "michelle.dunn@example.com", servicer: "rocket", loanType: "Conventional", rateType: "fixed", rate: 7.0, originalAmount: 296000, originationDate: "2024-05-06", termMonths: 360, escrowMonthly: 431.77, last4: "0471", asOf: "2026-11-03", connection: "login_required", lastGoodUpdate: "2026-11-03T12:02:00Z" },
  { id: "L08", borrower: "Chris Patel", email: "chris.patel@example.com", servicer: "pennymac", loanType: "Conventional", rateType: "fixed", rate: 6.875, originalAmount: 372000, originationDate: "2026-06-03", termMonths: 360, escrowMonthly: 498.06, last4: "3958" },
  { id: "L09", borrower: "James Holloway", email: "james.holloway@example.com", servicer: "freedom", loanType: "Conventional", rateType: "fixed", rate: 6.25, originalAmount: 280000, originationDate: "2023-01-05", termMonths: 180, escrowMonthly: 389.44, last4: "2294" },
  { id: "L10", borrower: "Tom and Ellen Gaines", email: "gaines.family@example.com", servicer: "chase", loanType: "Jumbo", rateType: "fixed", rate: 3.75, originalAmount: 960000, originationDate: "2019-08-05", termMonths: 360, escrowMonthly: 1112.5, last4: "7740" },
  { id: "L11", borrower: "Robert Tate", email: "robert.tate@example.com", servicer: "mrcooper", loanType: "Conventional", rateType: "fixed", rate: 2.875, originalAmount: 310000, originationDate: "2021-03-05", termMonths: 360, escrowMonthly: 372.18, last4: "8825" },
  { id: "L12", borrower: "Laura Simmons", email: "laura.simmons@example.com", servicer: "shellpoint", loanType: "VA", rateType: "fixed", rate: 3.25, originalAmount: 245000, originationDate: "2020-07-07", termMonths: 360, escrowMonthly: 298.33, last4: "1702" },
];

/** The demo's live-connect borrower (Jordan Avery at Rocket). */
export const FLOW_LOAN: TestLoan = {
  id: "L13",
  borrower: "Jordan Avery",
  email: "jordan.avery@example.com",
  servicer: "rocket",
  loanType: "Conventional",
  rateType: "fixed",
  rate: 7.125,
  originalAmount: 365000,
  originationDate: "2024-04-04",
  termMonths: 360,
  escrowMonthly: 402.91,
  last4: "2086",
};

/** The fields a servicer would report through Plaid for a test loan, built from its payment schedule. */
export function buildServicerRecord(t: TestLoan, extra?: Partial<ServicerRecord>): ServicerRecord {
  const asOf = parseDate(t.asOf || DEMO_AS_OF);
  const orig = parseDate(t.originationDate);
  const firstDue = firstDueDate(orig);
  const made = paymentsMadeBy(firstDue, asOf);
  const payment = monthlyPI(t.originalAmount, t.rate, t.termMonths);
  return {
    id: t.id,
    borrower: t.borrower,
    email: t.email,
    servicer: DEMO_SERVICERS[t.servicer] ?? t.servicer,
    connection: t.connection || "ok",
    lastUpdated: t.lastGoodUpdate || `${DEMO_AS_OF}T12:02:00Z`,
    interest_rate: { percentage: t.rate, type: t.rateType },
    current_balance: round2(balanceAfter(t.originalAmount, t.rate, t.termMonths, made)),
    next_monthly_payment: round2(round2(payment) + t.escrowMonthly),
    next_payment_due_date: isoDate(addMonths(firstDue, made)),
    origination_date: t.originationDate,
    origination_principal_amount: t.originalAmount,
    maturity_date: isoDate(addMonths(firstDue, t.termMonths - 1)),
    loan_term: t.termMonths / 12 + " year",
    loan_type_description: t.loanType,
    mask: t.last4,
    ...(extra || {}),
  };
}

/** All 13 demo loans as servicer records. Jordan Avery first, as in the demo after the live connect. */
export function demoRecords(): ServicerRecord[] {
  return [FLOW_LOAN, ...TEST_LOANS].map((t) => buildServicerRecord(t));
}
