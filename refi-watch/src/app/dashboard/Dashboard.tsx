"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconCheck, IconClock, IconDot, IconInfo, IconRefresh, IconX } from "@/components/icons";
import {
  ARM_NOTE,
  PI_FROM_BALANCE_NOTE,
  DEFAULT_SETTINGS,
  PRESETS,
  STATUS_LABEL,
  countStatuses,
  currentPIBasis,
  evaluate,
  fmtDate,
  intish,
  isNum,
  money,
  money0,
  moneyThr,
  pct,
  plural,
  pts,
  reasonText,
  thr,
  type PresetId,
  type RuleResult,
  type RuleSettings,
  type ServicerRecord,
  type Status,
} from "@/lib/rules";

export interface PendingInviteView {
  name: string;
  code: string;
}

export interface DashboardProps {
  orgName: string;
  records: ServicerRecord[];
  initialSettings: RuleSettings;
  initialPreset: PresetId;
  /** YYYY-MM-DD the rule is checked as of. */
  asOf: string;
  noKeys: boolean;
  plaidMode: "off" | "sandbox" | "production";
  staffEmail: string | null;
  pendingInvites: PendingInviteView[];
}

const SERVICER_SRC = "From the servicer, through Plaid";
const NR = "Not reported";
const SAVE_DELAY_MS = 800;
const noopSubscribe = () => () => {};

/* Time of the last update, in Alabama time, built by hand so server and browser render the same text. */
function fmtUpdated(iso: string | null | undefined): string {
  if (!iso) return "Not updated yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not updated yet";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || "").toUpperCase()}`;
}

function Chip({ status }: { status: Status }) {
  const icon = status === "ready" ? <IconCheck /> : status === "reconnect" ? <IconRefresh /> : status === "watch" ? <IconDot /> : status === "missing" ? <IconInfo /> : null;
  return (
    <span className={`chip chip-${status}`}>
      {icon}
      {STATUS_LABEL[status]}
    </span>
  );
}

const calcMoney = (r: RuleResult, x: number) => (r.missing.length ? "Not checked" : r.atMaturity ? "None" : money(x));
const leftText = (r: RuleResult) => (r.atMaturity ? "At maturity" : isNum(r.paymentsLeft) ? String(r.paymentsLeft) : NR);
const rateTypeText = (t: string | null) => (t === "variable" ? "ARM" : t === "fixed" ? "Fixed" : "Rate type not reported");

/* ---------------------------------------------------------------------------
   Number inputs that recompute on every valid keystroke and never flash junk.
   ------------------------------------------------------------------------- */
function NumField(props: {
  id: string;
  value: number;
  onValue: (v: number) => void;
  min: number;
  max: number;
  step: number;
  className?: string;
  label?: string;
}) {
  const { id, value, onValue, min, max, step, className, label } = props;
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : String(value);
  const parsed = Number(draft);
  const invalid = focused && (draft.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max);
  return (
    <input
      id={id}
      className={`num-in ${className || ""}`}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={shown}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onFocus={() => {
        setDraft(String(value));
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        const v = Number(t);
        if (t.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onValue(v);
      }}
    />
  );
}

/* ---------------------------------------------------------------------------
   Rule panel
   ------------------------------------------------------------------------- */
function RulePanel(props: {
  s: RuleSettings;
  preset: PresetId;
  set: (patch: Partial<RuleSettings>) => void;
  setPreset: (p: PresetId) => void;
  reset: () => void;
  live: string;
  saveState: "idle" | "saving" | "saved" | "error";
}) {
  const { s, preset, set, setPreset, reset, live, saveState } = props;
  const p = PRESETS[preset];
  return (
    <aside className="card rule-panel" aria-labelledby="ruleTitle">
      <div className="rp-top">
        <h2 className="rp-title" id="ruleTitle">
          Your rule
        </h2>
        <span className="src src-setting">Your setting</span>
      </div>
      <fieldset className="rp-group">
        <legend className="rp-legend">Your numbers</legend>
        <div className="grp">
          <div>
            <label className="ctl-label" htmlFor="todayRate">
              Today&apos;s rate you can offer (30-year fixed, conventional)
            </label>
            <div className="ctl-pair">
              <span className="ctl-unit">
                <NumField id="todayRate" value={s.todayRate} min={0} max={15} step={0.125} onValue={(v) => set({ todayRate: v })} />%
              </span>
              <input
                className="range"
                type="range"
                min={3}
                max={8}
                step={0.125}
                value={Math.min(8, Math.max(3, s.todayRate))}
                aria-label="Today's rate, slider"
                onChange={(e) => set({ todayRate: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <label className="ctl-label" htmlFor="closingCosts">
              Your typical closing costs
            </label>
            <div className="ctl-pair">
              <span className="ctl-unit">
                $<NumField id="closingCosts" className="wide" value={s.closingCosts} min={0} max={50000} step={250} onValue={(v) => set({ closingCosts: v })} />
              </span>
              <input
                className="range"
                type="range"
                min={0}
                max={12000}
                step={250}
                value={Math.min(12000, s.closingCosts)}
                aria-label="Closing costs, slider"
                onChange={(e) => set({ closingCosts: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <span className="ctl-label" id="termLabel">
              New term
            </span>
            <div className="seg" role="group" aria-labelledby="termLabel">
              <button type="button" aria-pressed={s.newTerm === "keep"} onClick={() => set({ newTerm: "keep" })}>
                Keep remaining term
              </button>
              <button type="button" aria-pressed={s.newTerm === "360"} onClick={() => set({ newTerm: "360" })}>
                New 30-year
              </button>
            </div>
          </div>
          <label className="switch" htmlFor="rollCosts">
            <span>Roll costs into the new loan</span>
            <input id="rollCosts" type="checkbox" checked={s.rollCosts} onChange={(e) => set({ rollCosts: e.target.checked })} />
          </label>
        </div>
      </fieldset>
      <fieldset className="rp-group">
        <legend className="rp-legend">Ready when all four are true</legend>
        <div className="grp">
          <label className="sent" htmlFor="minDrop">
            <span>Rate at least</span>
            <NumField id="minDrop" value={s.minDrop} min={0} max={5} step={0.125} onValue={(v) => set({ minDrop: v })} />
            <span>percentage points lower</span>
          </label>
          <label className="sent" htmlFor="minSavings">
            <span>Saves at least $</span>
            <NumField id="minSavings" value={s.minSavings} min={0} max={5000} step={10} onValue={(v) => set({ minSavings: v })} />
            <span>a month</span>
          </label>
          <label className="sent" htmlFor="maxPayback">
            <span>Costs paid back within</span>
            <NumField id="maxPayback" value={s.maxPayback} min={0} max={480} step={1} onValue={(v) => set({ maxPayback: v })} />
            <span>months</span>
          </label>
          <label className="sent" htmlFor="minSeasoning">
            <span>At least</span>
            <NumField id="minSeasoning" value={s.minSeasoning} min={0} max={360} step={1} onValue={(v) => set({ minSeasoning: v })} />
            <span>months since closing</span>
          </label>
          <div>
            <label className="sr-only" htmlFor="preset">
              Streamline starting point
            </label>
            <select id="preset" className="select" value={preset} onChange={(e) => setPreset(e.target.value as PresetId)}>
              <option value="standard">{PRESETS.standard.label}</option>
              <option value="va">{PRESETS.va.label}</option>
              <option value="fha">{PRESETS.fha.label}</option>
            </select>
            {p.appliesTo && <p className="preset-note">{p.note}</p>}
          </div>
        </div>
      </fieldset>
      <div className="rp-live" aria-live="polite">
        {live}
      </div>
      <div className="rp-foot">
        <b>Watch:</b> within 0.25 points, $50 or 12 months of your rule.{" "}
        <button className="linkbtn" type="button" onClick={reset}>
          Reset to defaults
        </button>
        <div>{saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved." : saveState === "error" ? "Could not save. Changes apply on this screen only." : ""}</div>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------------------
   Detail drawer: every field, its source, and the math.
   ------------------------------------------------------------------------- */
function RuleLines({ r, rec }: { r: RuleResult; rec: ServicerRecord }) {
  const s = r.s;
  const R = r.ruleName;
  const state = (k: "rate" | "savings" | "payback") => (r.tests[k] ? "ok" : r.watchLine === k ? "close" : "no");
  const icon = (st: string) => (st === "ok" ? <IconCheck /> : st === "close" ? <IconDot /> : <IconX />);
  const line = (k: "rate" | "savings" | "payback", text: string, rule: string) => {
    const st = state(k);
    return (
      <li className={`rl-${st}`}>
        <span className="rl-icon">{icon(st)}</span>
        <span className="rl-text">
          {text}
          {st === "close" && <span className="tag tag-close">close</span>}
        </span>
        <span className="rl-rule">{rule}</span>
      </li>
    );
  };
  const rateText = r.rateDrop >= 0 ? `Rate ${pts(r.rateDrop)} percentage points lower` : `Today's rate is ${pts(r.rateDrop)} percentage points higher`;
  const savText = r.atMaturity ? "No payments left" : r.savings > 0 ? `Saves ${money(r.savings)} a month` : `New P&I is ${money(-r.savings)} higher`;
  const pbText = r.paybackMonths === null ? "No payback" : `Paid back in ${r.paybackMonths} ${plural(r.paybackMonths, "month")}`;
  return (
    <ul className="rule-lines">
      {line("rate", rateText, `${R}: at least ${thr(s.minDrop)}`)}
      {line("savings", savText, `${R}: at least ${moneyThr(s.minSavings)}`)}
      {line("payback", pbText, `${R}: within ${intish(s.maxPayback)} months`)}
      <li className={r.tests.seasoning ? "rl-ok" : "rl-no"}>
        <span className="rl-icon">{r.tests.seasoning ? <IconCheck /> : <IconX />}</span>
        <span className="rl-text">
          {r.monthsSinceClosing} {plural(r.monthsSinceClosing, "month")} since closing
        </span>
        <span className="rl-rule">
          {R}: at least {intish(s.minSeasoning)}
        </span>
      </li>
      {r.connectionOk ? (
        <li className="rl-ok">
          <span className="rl-icon">
            <IconCheck />
          </span>
          <span className="rl-text">Connected</span>
          <span className="rl-rule">Updated {fmtUpdated(rec.lastUpdated)}</span>
        </li>
      ) : (
        <li className="rl-no">
          <span className="rl-icon">
            <IconX />
          </span>
          <span className="rl-text">Login needed</span>
          <span className="rl-rule">Plaid needs a new login</span>
        </li>
      )}
    </ul>
  );
}

function TermCompare({ r, s }: { r: RuleResult; s: RuleSettings }) {
  if (r.atMaturity) return null;
  const rows: Array<[string, number, number, string]> = [
    ["Current loan", r.interestLeftCurrent, r.paymentsLeft, ""],
    ["New, remaining term", r.interestNewKeep, r.paymentsLeft, " new"],
    ["New 30-year loan", r.interestNew30, 360, " alt"],
  ];
  const maxI = Math.max(...rows.map((x) => x[1]), 1);
  const diff30 = r.interestNew30 - r.interestNewKeep;
  return (
    <div className="interest">
      <h4>Term change, shown separately: interest left to pay</h4>
      {rows.map(([label, v, n, cls]) => (
        <div className="bar-row" key={label}>
          <span>{label}</span>
          <span className={`bar${cls}`}>
            <span style={{ width: `${((v / maxI) * 100).toFixed(1)}%` }} />
          </span>
          <span className="bar-val">
            {money(v)} <small>over {n} mo</small>
          </span>
        </div>
      ))}
      <p className="interest-note">
        Savings are compared at the loan&apos;s remaining term, so they come from the rate, not from a longer loan.
        {r.paymentsLeft < 360 && (
          <>
            {" "}
            A new 30-year term would make the P&amp;I <b>{money(r.newPI30)}</b> a month and add <b>{money(diff30)}</b> in total interest over keeping the remaining term.
          </>
        )}
        {s.newTerm === "360" && r.paymentsLeft < 360 && (
          <> You picked a new 30-year term, so the savings shown include the longer term. At the remaining term they would be {money(r.currentPI - r.newPIKeep)} a month.</>
        )}
        {s.rollCosts && <> The new loan includes your {moneyThr(s.closingCosts)} in closing costs.</>}
      </p>
    </div>
  );
}

function Drawer({ rec, r, s, onClose }: { rec: ServicerRecord; r: RuleResult; s: RuleSettings; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const miss = r.missing.length > 0;
  const ir = rec.interest_rate;
  return (
    <div className="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle" tabIndex={-1} ref={ref}>
      <div className="drawer-head">
        <div>
          <h2 className="d-name" id="drawerTitle">
            {rec.borrower}
          </h2>
          <p className="d-meta">
            {rec.servicer} · Loan ending {rec.mask || "not reported"} · {rec.loan_type_description || "Loan type not reported"}, {rateTypeText(r.rateType).toLowerCase()}
          </p>
          <div className="d-chipline">
            <Chip status={r.status} />
            <span className="d-meta" style={{ margin: 0 }}>
              {reasonText(r)}
            </span>
          </div>
        </div>
        <button className="close-btn" type="button" aria-label="Close details" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div className="drawer-body">
        {r.status === "reconnect" && (
          <div className="d-block">
            <div className="notice notice-clay">
              <IconRefresh />
              <div>
                <b>Reconnect needed.</b> Plaid needs the borrower to log in to {rec.servicer} again. The numbers below are from the last good update ({fmtUpdated(rec.lastUpdated)}). Send them their connect link again; it opens Plaid in update mode, so no new connection is created. Nothing is sent automatically.
              </div>
            </div>
          </div>
        )}
        {miss && r.status === "missing" && (
          <div className="d-block">
            <div className="notice notice-stone">
              <IconInfo />
              <div>
                <b>Missing data.</b> The servicer didn&apos;t report: {r.missing.join(", ")}. Refi Watch never guesses a number, so this loan isn&apos;t checked against your rule until the servicer reports it.
              </div>
            </div>
          </div>
        )}
        {!miss && (
          <div className="d-block">
            <div className="d-h">
              <span>{r.ruleName} on this loan</span>
              <span className="src src-setting">Your setting</span>
            </div>
            <RuleLines r={r} rec={rec} />
          </div>
        )}
        {r.notes.includes(ARM_NOTE) && (
          <div className="d-block">
            <div className="notice notice-clay">
              <IconInfo />
              <div>
                <b>{ARM_NOTE}</b> This loan has an adjustable rate. Plaid reports the current rate and that it is variable. It does not report when the rate adjusts next.
              </div>
            </div>
          </div>
        )}
        {r.notes.includes(PI_FROM_BALANCE_NOTE) && (
          <div className="d-block">
            <div className="notice notice-stone">
              <IconInfo />
              <div>
                <b>How current P&amp;I was figured.</b> The servicer didn&apos;t report this loan&apos;s original amount or term, so current P&amp;I is calculated from the servicer&apos;s current balance at the note rate over the payments left. For a loan paid on schedule, that matches the note payment. If the borrower paid extra principal, it will read a little low.
              </div>
            </div>
          </div>
        )}
        {r.heldForSeasoning && r.connectionOk && (
          <div className="d-block">
            <div className="notice notice-stone">
              <IconClock />
              <div>
                <b>Held for seasoning.</b> Passes rate, savings and payback, but closed {r.monthsSinceClosing} {plural(r.monthsSinceClosing, "month")} ago. {r.ruleName} needs {intish(r.s.minSeasoning)}. It becomes eligible on {fmtDate(r.eligibleDate)}.
              </div>
            </div>
          </div>
        )}

        <section className="d-section s-servicer">
          <div className="d-sh">
            <span className="src src-servicer">{SERVICER_SRC}</span>
            <small>{rec.connection === "ok" ? `Updated ${fmtUpdated(rec.lastUpdated)}` : `Last good update ${fmtUpdated(rec.lastUpdated)}`}</small>
          </div>
          <dl className="kv">
            <dt>Interest rate and type</dt>
            <dd>
              {pct(ir.percentage)} {ir.type === "variable" ? "ARM" : ir.type === "fixed" ? "fixed" : ""}
            </dd>
            <dt>Current balance</dt>
            <dd>
              {money(rec.current_balance)}
              <small>from the servicer account</small>
            </dd>
            <dt>Monthly payment</dt>
            <dd>
              {money(rec.next_monthly_payment)}
              <small>can include escrow</small>
            </dd>
            <dt>Next due date</dt>
            <dd>{fmtDate(rec.next_payment_due_date)}</dd>
            <dt>Origination date</dt>
            <dd>{fmtDate(rec.origination_date)}</dd>
            <dt>Original amount</dt>
            <dd>{money(rec.origination_principal_amount)}</dd>
            <dt>Maturity date</dt>
            <dd>
              {fmtDate(rec.maturity_date)}
              <small>{rec.loan_term ? `${rec.loan_term} term` : "term not reported"}</small>
            </dd>
            <dt>Loan type</dt>
            <dd>
              {rec.loan_type_description || NR}
              <small>as the servicer describes it</small>
            </dd>
            <dt>Loan number</dt>
            <dd>
              {rec.mask ? `ending ${rec.mask}` : NR}
              <small>last 4 digits only</small>
            </dd>
            <dt>Servicer</dt>
            <dd>{rec.servicer}</dd>
          </dl>
        </section>

        {!miss && (
          <section className="d-section s-calc">
            <div className="d-sh">
              <span className="src src-calc">Calculated</span>
              <small>math on the numbers above and your settings</small>
            </div>
            <dl className="kv">
              <dt>Current P&amp;I</dt>
              <dd>
                {money(r.currentPI)}
                <small>{currentPIBasis(rec, r)}</small>
              </dd>
              <dt>New P&amp;I at {pct(s.todayRate)}</dt>
              <dd>
                {calcMoney(r, r.newPI)}
                <small>
                  {money(r.newPrincipal)} over {r.newTermMonths} months{r.newTermMonths === r.paymentsLeft ? ", the remaining term" : ""}
                </small>
              </dd>
              <dt>Monthly savings</dt>
              <dd>
                {calcMoney(r, r.savings)}
                <small>P&amp;I only. Escrow and mortgage insurance are left out.</small>
              </dd>
              <dt>Payback</dt>
              <dd>
                {r.paybackMonths === null ? "No payback" : `${r.paybackMonths} ${plural(r.paybackMonths, "month")}`}
                <small>
                  {r.paybackMonths === null
                    ? r.savings > 0
                      ? "not paid back within the loan"
                      : "new P&I is not lower"
                    : `${moneyThr(s.closingCosts)} ÷ ${money(r.savings)}, rounded up`}
                </small>
              </dd>
              <dt>Rate drop</dt>
              <dd>
                {r.rateDrop >= 0 ? `${pts(r.rateDrop)} points` : "None"}
                <small>
                  {pct(r.rate)} minus {pct(s.todayRate)}
                </small>
              </dd>
              <dt>Payments left</dt>
              <dd>
                {leftText(r)}
                <small>
                  {fmtDate(rec.next_payment_due_date)} to {fmtDate(rec.maturity_date)}
                </small>
              </dd>
              <dt>Months since closing</dt>
              <dd>
                {r.monthsSinceClosing}
                <small>since {fmtDate(rec.origination_date)}</small>
              </dd>
            </dl>
            <TermCompare r={r} s={s} />
          </section>
        )}

        <section className="d-section s-setting">
          <div className="d-sh">
            <span className="src src-setting">Your setting</span>
            <small>change these in Your rule</small>
          </div>
          <dl className="kv">
            <dt>Today&apos;s rate you can offer (30-year fixed, conventional)</dt>
            <dd>{pct(s.todayRate)}</dd>
            <dt>Your typical closing costs</dt>
            <dd>{moneyThr(s.closingCosts)}</dd>
            <dt>Rule used for this loan</dt>
            <dd>{r.ruleName}</dd>
            <dt>Rate at least __ percentage points lower</dt>
            <dd>{thr(r.s.minDrop)}</dd>
            <dt>Saves at least $__ a month</dt>
            <dd>{moneyThr(r.s.minSavings)}</dd>
            <dt>Costs paid back within __ months</dt>
            <dd>{intish(r.s.maxPayback)}</dd>
            <dt>At least __ months since closing</dt>
            <dd>{intish(r.s.minSeasoning)}</dd>
            <dt>New term</dt>
            <dd>{s.newTerm === "360" ? "New 30-year term" : "Keep remaining term"}</dd>
            <dt>Roll costs into the new loan</dt>
            <dd>{s.rollCosts ? "On" : "Off"}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Invite a borrower: makes a connect link. Nothing is sent automatically.
   ------------------------------------------------------------------------- */
function InvitePanel({ pending }: { pending: PendingInviteView[] }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; url: string } | null>(null);
  const [err, setErr] = useState("");
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fullName: name, email }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setMade({ name, url: j.url });
      setName("");
      setEmail("");
    } catch (e2) {
      setErr(e2 instanceof Error && e2.message === "bad_email" ? "That email doesn't look right." : "Could not create the invite.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card invite" aria-labelledby="inviteTitle">
      <h2 id="inviteTitle">Invite a borrower</h2>
      <p>Makes a private connect link for one borrower. Nothing is sent automatically: copy the link and send it yourself.</p>
      <form onSubmit={submit}>
        <label className="sr-only" htmlFor="invName">
          Borrower name
        </label>
        <input id="invName" className="text-in" placeholder="Borrower name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <label className="sr-only" htmlFor="invEmail">
          Email (optional)
        </label>
        <input id="invEmail" className="text-in" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
        <button className="btn btn-ghost" type="submit" disabled={busy || !name.trim()}>
          Create link
        </button>
      </form>
      {err && <p className="err">{err}</p>}
      {made && (
        <p className="invite-link">
          Link for {made.name}: <a href={made.url}>{made.url}</a>{" "}
          <button className="linkbtn" type="button" onClick={() => navigator.clipboard?.writeText(made.url)}>
            Copy
          </button>
        </p>
      )}
      {pending.length > 0 && (
        <ul aria-label="Invites not connected yet">
          {pending.map((p) => (
            <li key={p.code}>
              <span>{p.name}: not connected yet</span>
              <a href={`${origin}/connect/${p.code}`}>Connect link</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   The dashboard
   ------------------------------------------------------------------------- */
export default function Dashboard(props: DashboardProps) {
  const { records, asOf, noKeys, plaidMode, staffEmail, orgName } = props;
  const [s, setS] = useState<RuleSettings>(props.initialSettings);
  const [preset, setPresetState] = useState<PresetId>(props.initialPreset);
  const [openId, setOpenId] = useState<string | null>(null);
  const [live, setLive] = useState(`${records.length} loans checked against your rule.`);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStatuses = useRef<Map<string, Status> | null>(null);

  const results = useMemo(() => records.map((rec) => evaluate(rec, s, preset, asOf)), [records, s, preset, asOf]);
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);

  // Announce how many loans changed status after a rule edit.
  useEffect(() => {
    const now = new Map(results.map((r) => [r.id, r.status]));
    if (prevStatuses.current) {
      let changed = 0;
      now.forEach((st, id) => {
        if (prevStatuses.current!.get(id) !== st) changed++;
      });
      setLive(`${results.length} loans rechecked. ` + (changed === 0 ? "No status changes." : `${changed} changed status.`));
    }
    prevStatuses.current = now;
  }, [results]);

  const save = useCallback((next: RuleSettings, nextPreset: PresetId) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: next, preset: nextPreset }) });
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    }, SAVE_DELAY_MS);
  }, []);

  const set = (patch: Partial<RuleSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    save(next, preset);
  };
  const setPreset = (p: PresetId) => {
    setPresetState(p);
    save(s, p);
  };
  const reset = () => {
    const next = { ...DEFAULT_SETTINGS };
    setS(next);
    setPresetState("standard");
    save(next, "standard");
  };

  const c = countStatuses(results);
  const ok = results.filter((r) => r.connectionOk).length;
  const readySavings = results.filter((r) => r.status === "ready").reduce((a, r) => a + r.savings, 0);
  const open = openId ? results.find((r) => r.id === openId) : null;
  const openRec = openId ? byId.get(openId) : null;
  const closeDrawer = useCallback(() => setOpenId(null), []);

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand">
            <span className="brand-name">{orgName}</span>
            <span className="brand-sep" aria-hidden="true">
              ·
            </span>
            <span className="brand-product">Refi Watch</span>
          </div>
          <div className="top-right">
            {noKeys && (
              <span className="test-badge" role="note">
                Test data. Not real borrowers.
              </span>
            )}
            <span>Checked as of {fmtDate(asOf)}</span>
            <a className="linkbtn" href="/api/export">
              Export CSV
            </a>
            {!noKeys && (
              <form action="/auth/signout" method="post">
                <span>{staffEmail}</span>{" "}
                <button className="linkbtn" type="submit">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </div>
      </header>
      {noKeys && (
        <div className="banner" role="note">
          <div className="banner-in">
            <b>Local test mode.</b> No Supabase keys are set, so staff login and two-factor are off and this dashboard shows the demo&apos;s 13 test loans from memory, checked as of the demo date. Changes are lost on restart.{" "}
            {plaidMode === "off" ? "No Plaid keys either: the connect page simulates the Plaid step." : `Plaid ${plaidMode} keys are set.`}
          </div>
        </div>
      )}
      <main className="workspace" id="main">
        <RulePanel s={s} preset={preset} set={set} setPreset={setPreset} reset={reset} live={live} saveState={saveState} />
        <div className="main-col">
          <h1 className="sr-only">Refi Watch dashboard</h1>
          <div className="kpis">
            <div className="card kpi">
              <div className="kpi-label">Connected loans</div>
              <div className="kpi-num" data-testid="kpi-connected">
                {results.length}
              </div>
              <div className="kpi-sub">
                {ok} connected
                {c.reconnect ? ` · ${c.reconnect} to reconnect` : ""}
                {c.missing ? ` · ${c.missing} missing data` : ""}
              </div>
            </div>
            <div className="card kpi k-ready">
              <div className="kpi-label">Meet your rule</div>
              <div className="kpi-num" data-testid="kpi-ready">
                {c.ready}
              </div>
              <div className="kpi-sub">
                <span className="src src-calc">Calculated, your rule</span>
              </div>
            </div>
            <div className="card kpi k-watch">
              <div className="kpi-label">Watch list</div>
              <div className="kpi-num" data-testid="kpi-watch">
                {c.watch}
              </div>
              <div className="kpi-sub">within 0.25 points, $50 or 12 months of your rule</div>
            </div>
            <div className="card kpi">
              <div className="kpi-label">Borrowers&apos; combined savings a month</div>
              <div className="kpi-num" data-testid="kpi-savings">
                {money0(readySavings)}
              </div>
              <div className="kpi-sub">
                P&amp;I only, {c.ready} {plural(c.ready, "loan")} · <span className="src src-calc">Calculated</span>
              </div>
            </div>
          </div>

          <div className="card table-card">
            <div className="table-top">
              <div>
                <h2 className="table-title">Past clients</h2>
                <p className="table-hint">Loan numbers from each servicer, through Plaid. Click a row for every field, its source and the math.</p>
              </div>
              <div className="legend" aria-label="Number sources">
                <span className="src src-servicer">{SERVICER_SRC}</span>
                <span className="src src-calc">Calculated</span>
                <span className="src src-setting">Your setting</span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="loans">
                <caption className="sr-only">Connected loans with servicer numbers, calculated refinance numbers and status under your rule</caption>
                <thead>
                  <tr className="groups">
                    <th scope="col">
                      <span className="sr-only">Borrower</span>
                    </th>
                    <th className="g-servicer" colSpan={4} scope="colgroup">
                      {SERVICER_SRC}
                    </th>
                    <th className="g-calc" colSpan={5} scope="colgroup">
                      Calculated
                    </th>
                    <th scope="col">
                      <span className="sr-only">Status</span>
                    </th>
                  </tr>
                  <tr className="cols">
                    <th className="l" scope="col">
                      Borrower
                    </th>
                    <th className="l" scope="col">
                      Loan type<span className="th-sub">Servicer</span>
                    </th>
                    <th scope="col">
                      Rate<span className="th-sub">Type</span>
                    </th>
                    <th scope="col">Current balance</th>
                    <th scope="col">
                      Monthly payment<span className="th-sub">Next due</span>
                    </th>
                    <th scope="col">Current P&amp;I</th>
                    <th scope="col">
                      Payments left<span className="th-sub">Since closing</span>
                    </th>
                    <th scope="col">New P&amp;I at {pct(s.todayRate)}</th>
                    <th scope="col">Savings a month</th>
                    <th scope="col">Payback</th>
                    <th className="l" scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => {
                    const rec = byId.get(r.id)!;
                    const miss = r.missing.length > 0;
                    const isArm = r.rateType === "variable";
                    const stretch = !miss && !r.atMaturity && r.newTermMonths - r.paymentsLeft >= 60 ? `new term adds ${Math.round((r.newTermMonths - r.paymentsLeft) / 12)} yrs` : "";
                    const payback = miss ? "Not checked" : r.atMaturity ? "None" : r.paybackMonths === null ? "No payback" : `${r.paybackMonths} mo`;
                    return (
                      <tr key={r.id} data-id={r.id} className={openId === r.id ? "is-open" : ""} onClick={() => setOpenId(r.id)}>
                        <td className="l wrap">
                          <button
                            type="button"
                            className="b-open"
                            aria-label={`Open details for ${rec.borrower}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenId(r.id);
                            }}
                          >
                            {rec.borrower}
                          </button>
                          {rec.isNew && <span className="tag tag-new">New</span>}
                          <span className={`b-meta${rec.connection !== "ok" ? " warn" : ""}`}>{rec.connection !== "ok" ? "Login needed" : `Updated ${fmtUpdated(rec.lastUpdated)}`}</span>
                        </td>
                        <td className="l wrap">
                          {rec.loan_type_description || NR}
                          <span className="cell-sub">{rec.servicer}</span>
                        </td>
                        <td>
                          {pct(rec.interest_rate.percentage)}
                          <span className="cell-sub">{isArm ? <span className="tag tag-arm">ARM</span> : rateTypeText(r.rateType)}</span>
                        </td>
                        <td>{money(rec.current_balance)}</td>
                        <td>
                          {money(rec.next_monthly_payment)}
                          <span className="cell-sub">{rec.next_payment_due_date ? `due ${fmtDate(rec.next_payment_due_date)}` : "due date not reported"}</span>
                        </td>
                        <td>{miss ? "Not checked" : money(r.currentPI)}</td>
                        <td>
                          {miss ? "Not checked" : leftText(r)}
                          {!miss && <span className="cell-sub">{r.monthsSinceClosing} mo</span>}
                        </td>
                        <td>{calcMoney(r, r.newPI)}</td>
                        <td className={!miss && !r.atMaturity && r.savings >= 1 ? "sav" : "neg"}>
                          {calcMoney(r, r.savings)}
                          {stretch && <span className="cell-sub">{stretch}</span>}
                        </td>
                        <td className={r.paybackMonths === null && !miss ? "neg" : ""}>{payback}</td>
                        <td className="c-status">
                          <Chip status={r.status} />
                          <span className="why">{reasonText(r)}</span>
                          {isArm && <span className="why">{ARM_NOTE}</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {results.length === 0 && (
                    <tr>
                      <td colSpan={11} className="empty">
                        No connected loans yet. Create an invite link below and send it to a borrower.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="table-note">
              {noKeys && (
                <>
                  Test data. Not real borrowers.
                  <br />
                </>
              )}
              Savings compare principal and interest only. Escrow and mortgage insurance are left out. The servicer&apos;s monthly payment can include escrow. Savings are compared at the loan&apos;s remaining term, so they come from the rate, not from a longer loan. Refinance numbers are for staff only and are never shown to borrowers.
            </p>
          </div>
          <InvitePanel pending={props.pendingInvites} />
        </div>
      </main>
      {open && openRec && <Drawer rec={openRec} r={open} s={s} onClose={closeDrawer} />}
    </>
  );
}
