/**
 * GET /api/export  Staff only. CSV of the loans table as the rule sees it today.
 * Every export is written to the audit log. No emails in the file.
 */
import { staffOrError } from "@/lib/auth";
import { ORG_DISPLAY } from "@/lib/config";
import { getStore } from "@/lib/db";
import { STATUS_LABEL, evaluate, reasonText, todayISO } from "@/lib/rules";

const cell = (v: unknown): string => {
  let s = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // no spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "");

export async function GET() {
  const auth = await staffOrError();
  if ("response" in auth) return auth.response;
  const store = getStore();
  const data = await store.loadDashboard(auth.staff.orgId);
  const asOf = data.fixedAsOf ?? todayISO(ORG_DISPLAY.timeZone);

  const header = [
    "Borrower", "Servicer", "Loan ending", "Rate %", "Rate type", "Current balance", "Monthly payment (servicer)", "Next due date",
    "Current P&I (calculated)", `New P&I at ${data.settings.todayRate}%`, "Monthly savings (P&I only)", "Payback months", "Payments left",
    "Months since closing", "Status", "Reason", "Last updated",
  ];
  const rows = data.records.map((rec) => {
    const r = evaluate(rec, data.settings, data.preset, asOf);
    return [
      rec.borrower, rec.servicer, rec.mask, rec.interest_rate.percentage, rec.interest_rate.type, rec.current_balance, rec.next_monthly_payment,
      rec.next_payment_due_date, money(r.currentPI), money(r.newPI), money(r.savings), r.paybackMonths, r.paymentsLeft, r.monthsSinceClosing,
      STATUS_LABEL[r.status], reasonText(r), rec.lastUpdated,
    ];
  });
  const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  await store.audit(auth.staff.orgId, auth.staff.userId, "export", { rows: rows.length, asOf });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="refi-watch-${asOf}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
