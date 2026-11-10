/**
 * Data minimization for /liabilities/get.
 *
 * Builds a new object from an allow-list of fields. Nothing else from the Plaid
 * response is kept: no escrow, PMI, property address, past-due amounts, late fees,
 * last payment, YTD figures, prepayment penalty, or full account number.
 * The full account number is reduced to its last 4 characters here and never
 * leaves this function.
 */

export interface MinimalLoan {
  /** Plaid's opaque account id (not an account number). Used only to update the same loan on refresh. */
  plaid_account_id: string;
  servicer_name: string | null;
  interest_rate_percentage: number | null;
  interest_rate_type: "fixed" | "variable" | null;
  current_balance: number | null;
  next_monthly_payment: number | null;
  next_payment_due_date: string | null;
  origination_date: string | null;
  origination_principal_amount: number | null;
  maturity_date: string | null;
  loan_term: string | null;
  loan_type_description: string | null;
  account_last4: string | null;
}

export const MINIMAL_LOAN_KEYS: ReadonlyArray<keyof MinimalLoan> = [
  "plaid_account_id",
  "servicer_name",
  "interest_rate_percentage",
  "interest_rate_type",
  "current_balance",
  "next_monthly_payment",
  "next_payment_due_date",
  "origination_date",
  "origination_principal_amount",
  "maturity_date",
  "loan_term",
  "loan_type_description",
  "account_last4",
];

/** The slice of the /liabilities/get response this reads. Everything else is ignored. */
export interface LiabilitiesLike {
  accounts?: Array<{ account_id?: string; mask?: string | null; balances?: { current?: number | null } | null } | null> | null;
  item?: { institution_name?: string | null } | null;
  liabilities?: { mortgage?: Array<Record<string, unknown> | null> | null } | null;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const date = (x: unknown): string | null => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
const text = (x: unknown, max: number): string | null => {
  if (typeof x !== "string") return null;
  const t = x.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};
/** Last 4 characters of a mask or account number, letters and digits only. */
export function last4(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const clean = x.replace(/[^0-9A-Za-z]/g, "");
  return clean ? clean.slice(-4) : null;
}
function rateType(x: unknown): "fixed" | "variable" | null {
  const t = typeof x === "string" ? x.trim().toLowerCase() : "";
  return t === "fixed" || t === "variable" ? t : null;
}

export function mapLiabilities(resp: LiabilitiesLike, institutionName?: string | null): MinimalLoan[] {
  const accounts = (resp.accounts || []).filter((a): a is NonNullable<typeof a> => Boolean(a && a.account_id));
  const servicer = text(resp.item?.institution_name, 120) ?? text(institutionName, 120);
  const out: MinimalLoan[] = [];
  for (const m of resp.liabilities?.mortgage || []) {
    if (!m || typeof m.account_id !== "string") continue;
    const acct = accounts.find((a) => a.account_id === m.account_id);
    const ir = (m.interest_rate && typeof m.interest_rate === "object" ? m.interest_rate : {}) as Record<string, unknown>;
    out.push({
      plaid_account_id: m.account_id,
      servicer_name: servicer,
      interest_rate_percentage: num(ir.percentage),
      interest_rate_type: rateType(ir.type),
      current_balance: num(acct?.balances?.current),
      next_monthly_payment: num(m.next_monthly_payment),
      next_payment_due_date: date(m.next_payment_due_date),
      origination_date: date(m.origination_date),
      origination_principal_amount: num(m.origination_principal_amount),
      maturity_date: date(m.maturity_date),
      loan_term: text(m.loan_term, 40),
      loan_type_description: text(m.loan_type_description, 80),
      account_last4: last4(acct?.mask) ?? last4(m.account_number),
    });
  }
  return out;
}
