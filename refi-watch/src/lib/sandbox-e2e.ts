/**
 * Plaid Sandbox end-to-end run, used by scripts/sandbox-e2e.ts (npm run sandbox:e2e).
 *
 * Runs the app's own code against Plaid Sandbox, with no browser:
 *   /sandbox/public_token/create (products ["liabilities"])
 *   -> POST /api/plaid/exchange (the real route handler: exchange, encrypt, save, first refresh)
 *   -> refreshItem -> /liabilities/get -> mapLiabilities (allowed fields only)
 *   -> the rule engine, as of today
 *   -> /sandbox/item/fire_webhook LIABILITIES DEFAULT_UPDATE, if a webhook URL is set.
 *
 * Storage is the in-memory store only: a sandbox run never writes to the live database.
 * Nothing secret is returned or printed (no access token, no public token, no keys).
 */
import "server-only";
import { POST as exchangeRoute } from "@/app/api/plaid/exchange/route";
import { ORG_DISPLAY, plaidEnv, plaidWebhookUrl } from "./config";
import { decryptToken } from "./crypto";
import { DEMO_ORG_ID, getStore } from "./db";
import { describePlaidError, getPlaid } from "./plaid";
import { refreshItem, type RefreshResult } from "./refresh";
import {
  DEFAULT_SETTINGS,
  STATUS_LABEL,
  currentPIBasis,
  evaluate,
  fmtDate,
  money,
  moneyThr,
  pct,
  plural,
  reasonText,
  todayISO,
  type RuleResult,
  type RuleSettings,
  type ServicerRecord,
} from "./rules";

/** First Platypus Bank, a Plaid Sandbox institution that supports Liabilities. */
export const DEFAULT_SANDBOX_INSTITUTION = "ins_109508";
export const SANDBOX_BORROWER = "Sandbox Test Borrower";

export interface SandboxRunOptions {
  institutionId?: string;
  /** Defaults to PLAID_WEBHOOK_URL. Empty string: no webhook. */
  webhookUrl?: string;
  /** YYYY-MM-DD. Defaults to today in Central time. */
  asOf?: string;
  settings?: RuleSettings;
  log?: (line: string) => void;
}

export interface SandboxLoan {
  rec: ServicerRecord;
  r: RuleResult;
}

export interface SandboxRunResult {
  institutionId: string;
  itemId: string;
  asOf: string;
  settings: RuleSettings;
  loans: SandboxLoan[];
  webhook: { fired: true; url: string } | { fired: false; reason: string };
  /** What a DEFAULT_UPDATE webhook runs (refreshItem by item id), run here directly. */
  webhookRefresh: RefreshResult;
}

export class SandboxRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRunError";
  }
}

const step = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SandboxRunError) throw e;
    const plaidText = describePlaidError(e);
    // Not a Plaid API error (network, timeout): its message is safe to show; never the object itself.
    const detail = plaidText.startsWith("Plaid ") || !(e instanceof Error) ? plaidText : `${e.name}: ${e.message.slice(0, 200)}`;
    throw new SandboxRunError(`${what}: ${detail}`);
  }
};

export async function runSandboxE2E(opts: SandboxRunOptions = {}): Promise<SandboxRunResult> {
  const log = opts.log ?? (() => {});
  const rawEnv = (process.env.PLAID_ENV || "").trim();
  if ((rawEnv && rawEnv !== "sandbox") || plaidEnv() !== "sandbox") {
    throw new SandboxRunError(`PLAID_ENV is "${rawEnv}". This script only runs against Plaid Sandbox: set PLAID_ENV=sandbox.`);
  }
  const store = getStore();
  if (store.kind !== "memory") throw new SandboxRunError("A sandbox run must use the in-memory store. Unset the SUPABASE_* variables for this run.");

  const institutionId = opts.institutionId || DEFAULT_SANDBOX_INSTITUTION;
  const webhookUrl = opts.webhookUrl ?? plaidWebhookUrl() ?? "";
  const asOf = opts.asOf ?? todayISO(ORG_DISPLAY.timeZone);
  const settings = opts.settings ?? { ...DEFAULT_SETTINGS };
  const plaid = getPlaid();

  // 1. A sandbox public token, the same thing Plaid Link hands the browser.
  const created = await step("/sandbox/public_token/create", () =>
    plaid.sandbox.createPublicToken({
      institution_id: institutionId,
      initial_products: ["liabilities"],
      ...(webhookUrl ? { options: { webhook: webhookUrl } } : {}),
    }),
  );
  log(`1. Created a sandbox public token at ${institutionId} (products: liabilities${webhookUrl ? ", webhook set" : ""}).`);

  // 2. The borrower's browser would now call POST /api/plaid/exchange. Call the same handler.
  const { code } = await store.createInvite(DEMO_ORG_ID, SANDBOX_BORROWER, null);
  const res = await exchangeRoute(
    new Request("http://localhost/api/plaid/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: code, public_token: created.public_token, institution_name: null }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; refreshed?: boolean; error?: string };
  if (!res.ok) throw new SandboxRunError(`POST /api/plaid/exchange answered ${res.status} ${body.error ?? ""}`.trim());
  const item = (await store.getInvite(code))?.item;
  if (!item) throw new SandboxRunError("The exchange answered ok but no item was saved.");
  if (!item.accessTokenEnc.startsWith("v1.")) throw new SandboxRunError("The access token was not stored encrypted.");
  log(`2. Exchanged through POST /api/plaid/exchange: item ${item.itemId}, access token stored encrypted (AES-256-GCM).`);
  if (!body.refreshed) throw new SandboxRunError("The first /liabilities/get after the exchange failed (see the error logged above).");

  // 3. The loans as the dashboard reads them, checked against the rule as of today.
  const dash = await store.loadDashboard(DEMO_ORG_ID);
  const loans = dash.records.filter((rec) => rec.borrower === SANDBOX_BORROWER).map((rec) => ({ rec, r: evaluate(rec, settings, "standard", asOf) }));
  if (!loans.length) throw new SandboxRunError("/liabilities/get returned no mortgage for this item.");
  log(`3. /liabilities/get mapped to the allowed fields only: ${loans.length} ${plural(loans.length, "mortgage")}.`);

  // 4. Fire a LIABILITIES DEFAULT_UPDATE at the webhook URL, if there is one.
  let webhook: SandboxRunResult["webhook"];
  if (webhookUrl) {
    const accessToken = decryptToken(item.accessTokenEnc, item.itemId);
    await step("/sandbox/item/fire_webhook", () =>
      plaid.sandbox.fireItemWebhook({ access_token: accessToken, webhook_type: "LIABILITIES", webhook_code: "DEFAULT_UPDATE" }),
    );
    webhook = { fired: true, url: webhookUrl };
    log(`4. Fired LIABILITIES DEFAULT_UPDATE. Plaid will POST it to ${webhookUrl}.`);
  } else {
    webhook = { fired: false, reason: "PLAID_WEBHOOK_URL is not set" };
    log("4. Skipped the webhook: PLAID_WEBHOOK_URL is not set.");
  }

  // 5. What the webhook handler runs on DEFAULT_UPDATE, run here against this item.
  const webhookRefresh = await refreshItem(item.itemId);
  log(`5. Ran the DEFAULT_UPDATE refresh locally: ${webhookRefresh.ok ? `ok, ${webhookRefresh.loans} ${plural(webhookRefresh.loans, "loan")}` : `failed (${webhookRefresh.code})`}.`);

  return { institutionId, itemId: item.itemId, asOf, settings, loans, webhook, webhookRefresh };
}

const row = (label: string, value: string, note?: string) => `    ${label.padEnd(22)}${value}${note ? `  (${note})` : ""}`;

/** Readable summary of one loan: the servicer's fields, then the math. Plain text, no secrets. */
export function formatLoanSummary({ rec, r }: SandboxLoan, settings: RuleSettings, asOf: string): string[] {
  const ir = rec.interest_rate;
  const lines = [
    `Loan: ${rec.servicer}${rec.mask ? `, ending ${rec.mask}` : ""}`,
    "  From the servicer, through Plaid",
    row("Interest rate", `${pct(ir.percentage)}${ir.type ? ` ${ir.type}` : ""}`),
    row("Current balance", money(rec.current_balance)),
    row("Next monthly payment", money(rec.next_monthly_payment), "Plaid's figure; may include escrow"),
    row("Next due date", fmtDate(rec.next_payment_due_date)),
    row("Origination", `${fmtDate(rec.origination_date)}, ${money(rec.origination_principal_amount)}`),
    row("Loan term", rec.loan_term ?? "Not reported"),
    row("Maturity date", fmtDate(rec.maturity_date)),
    row("Loan type", rec.loan_type_description ?? "Not reported"),
    `  Calculated (today's rate ${pct(settings.todayRate)}, closing costs ${moneyThr(settings.closingCosts)}, as of ${fmtDate(asOf)})`,
  ];
  if (r.missing.length) {
    lines.push(row("Missing", r.missing.join(", ")));
  } else {
    lines.push(
      row("Current P&I", money(r.currentPI), currentPIBasis(rec, r)),
      row("New P&I", money(r.newPI), `${money(r.newPrincipal)} over ${r.newTermMonths} months${r.newTermMonths === r.paymentsLeft ? ", the remaining term" : ""}`),
      row("Monthly savings", money(r.savings), "P&I only"),
      row("Payback", r.paybackMonths === null ? "No payback" : `${r.paybackMonths} ${plural(r.paybackMonths, "month")}`),
      row("Payments left", String(r.paymentsLeft)),
      row("Months since closing", String(r.monthsSinceClosing)),
    );
  }
  lines.push(row("Status", STATUS_LABEL[r.status]), row("Reason", reasonText(r)));
  for (const n of r.notes) lines.push(`    Note: ${n}`);
  return lines;
}
