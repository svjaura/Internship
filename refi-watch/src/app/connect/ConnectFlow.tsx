"use client";

import { useCallback, useState } from "react";
import type { PlaidLinkOnExit, PlaidLinkOnSuccess } from "react-plaid-link";
import { IconCheck, IconLock } from "@/components/icons";
import PlaidLauncher from "./PlaidLauncher";

export interface ConnectFlowProps {
  invite: string;
  firstName: string;
  orgName: string;
  /** First name of the loan officer, e.g. "Michael". */
  contactFirstName: string;
  contactName: string;
  phone: string;
  initialState: "new" | "connected" | "reconnect";
  /** "off": no Plaid keys, the Plaid step is simulated (test mode). */
  plaidMode: "off" | "sandbox" | "production";
  privacyUrl: string | null;
  /** Borrower-facing refinance view. Off until Michael approves wording and disclosures. */
  refiViewEnabled: boolean;
}

type Phase = "consent" | "starting" | "linking" | "saving" | "done" | "error";

export const OAUTH_STORE_KEY = "refiwatch_oauth";

export default function ConnectFlow(p: ConnectFlowProps) {
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>(p.initialState === "connected" ? "done" : "consent");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [simulated, setSimulated] = useState(false);
  const [servicer, setServicer] = useState<string | null>(null);
  const reconnect = p.initialState === "reconnect";

  async function start() {
    setPhase("starting");
    setError("");
    try {
      const res = await fetch("/api/plaid/link-token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: p.invite, consent: true }) });
      const j = await res.json();
      if (res.status === 409) {
        setPhase("done");
        return;
      }
      if (!res.ok) throw new Error(j.error || "link_token_failed");
      if (j.testMode) {
        setSimulated(true);
        setPhase("done");
        return;
      }
      try {
        // Kept for an OAuth bank, which sends the borrower away and back to /connect/oauth.
        sessionStorage.setItem(OAUTH_STORE_KEY, JSON.stringify({ token: j.link_token, invite: p.invite }));
      } catch {
        /* storage blocked: OAuth return will ask to start again */
      }
      setToken(j.link_token);
      setPhase("linking");
    } catch {
      setError("We couldn't start the secure connection. Please try again in a minute, or call us.");
      setPhase("error");
    }
  }

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      setPhase("saving");
      setServicer(metadata.institution?.name ?? null);
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invite: p.invite, public_token: publicToken, institution_name: metadata.institution?.name ?? null }),
        });
        if (!res.ok && res.status !== 409) throw new Error("exchange_failed");
        try {
          sessionStorage.removeItem(OAUTH_STORE_KEY);
        } catch {}
        setPhase("done");
      } catch {
        setError("Your servicer connected, but we couldn't save it. Please call us so we can finish it for you.");
        setPhase("error");
      }
    },
    [p.invite],
  );

  const onExit = useCallback<PlaidLinkOnExit>((err) => {
    setToken(null);
    if (err) {
      setError(err.display_message || "The connection didn't finish. You can try again.");
      setPhase("error");
    } else {
      setPhase("consent");
    }
  }, []);

  if (phase === "done") {
    const already = p.initialState === "connected" && !simulated;
    return (
      <div>
        {simulated && (
          <div className="notice notice-clay" role="note" style={{ marginBottom: 14 }}>
            <div>
              <b>Test mode.</b> This is the screen a borrower sees after connecting. No Plaid keys are set, so the Plaid step was simulated: nothing was connected and no data was shared.
            </div>
          </div>
        )}
        <h1 className="site-h">{already ? `You're already connected, ${p.firstName}.` : `You're connected, ${p.firstName}.`}</h1>
        <p className="site-lead">
          Your {servicer ? `${servicer} ` : ""}mortgage is connected. {p.contactFirstName} gets a note if refinancing could lower your payment, and reaches out personally only if it makes sense for you.
        </p>
        <ul className="done-list">
          <li>Your password stayed with Plaid and your servicer.</li>
          <li>Nothing is sent to you automatically.</li>
          <li>
            Changed your mind? Call <a href={`tel:${p.phone.replace(/[^0-9]/g, "")}`}>{p.phone}</a> to disconnect any time.
          </li>
        </ul>
        {p.refiViewEnabled && (
          <div className="notice notice-stone" style={{ marginTop: 16 }}>
            <div>A refinance preview will appear here once the wording and disclosures are approved.</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {p.plaidMode === "off" && (
        <div className="notice notice-clay" role="note" style={{ marginBottom: 14 }}>
          <div>
            <b>Test mode.</b> No Plaid keys are set on this server. The Connect button simulates the Plaid step and nothing is shared.
          </div>
        </div>
      )}
      {p.plaidMode === "sandbox" && (
        <div className="notice notice-stone" role="note" style={{ marginBottom: 14 }}>
          <div>
            <b>Plaid Sandbox.</b> Use Plaid&apos;s test login (user_good / pass_good). No real bank is contacted.
          </div>
        </div>
      )}
      <h1 className="site-h">{reconnect ? "Reconnect your mortgage" : "Connect your mortgage"}</h1>
      <p className="site-lead">
        {reconnect
          ? `Hi ${p.firstName}. Your servicer asked for a fresh login, so the connection paused. Log in through Plaid again and it picks up where it left off.`
          : `Hi ${p.firstName}. ${p.contactName} gets a note when refinancing could lower your payment, and reaches out only if it makes sense for you.`}
      </p>
      <div className="share-grid">
        <section className="card share-card yes" aria-labelledby="shareYes">
          <h2 id="shareYes" style={{ fontSize: 16, fontWeight: 750, margin: 0 }}>
            What gets shared
          </h2>
          <p className="share-sub">From your mortgage servicer, through Plaid</p>
          <ul>
            <li>Interest rate and rate type</li>
            <li>Current balance</li>
            <li>Monthly payment and next due date</li>
            <li>Loan start date</li>
            <li>Original amount</li>
            <li>Loan term and maturity date</li>
            <li>Loan type</li>
            <li>Your servicer&apos;s name</li>
            <li>Last 4 digits of your loan number</li>
          </ul>
          <p className="share-foot">
            {p.orgName} also keeps your name, your email, whether you&apos;re connected and when your loan last updated. Nothing else. Only your mortgage connects, not checking, savings or card accounts.
          </p>
        </section>
        <section className="card share-card no" aria-labelledby="shareNo">
          <h2 id="shareNo" style={{ fontSize: 16, fontWeight: 750, margin: 0 }}>
            Never shared or stored
          </h2>
          <ul style={{ marginTop: 6 }}>
            <li>Your password or verification codes</li>
            <li>Your Social Security number</li>
            <li>Your bank transactions</li>
            <li>Your full account number</li>
            <li>Escrow, mortgage insurance, property address, past-due amounts or late fees</li>
          </ul>
          <p className="share-foot">
            <b>Disconnect any time.</b> Call {p.phone}.
          </p>
        </section>
      </div>
      <label className="consent" htmlFor="consent">
        <input id="consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={phase !== "consent" && phase !== "error"} />
        <span>
          I agree to share these mortgage details from my servicer with {p.orgName} through Plaid, so {p.orgName} can tell me when a refinance could lower my payment. This is not a credit check. I can disconnect any time.
        </span>
      </label>
      {p.privacyUrl && (
        <p className="share-foot">
          <a href={p.privacyUrl}>{p.orgName} privacy notice</a>
        </p>
      )}
      <div className="site-actions">
        <button className="btn btn-primary btn-lg" type="button" disabled={!consent || (phase !== "consent" && phase !== "error")} onClick={start}>
          <IconLock />
          {phase === "starting" || phase === "linking" ? "Opening Plaid..." : phase === "saving" ? "Saving..." : reconnect ? "Reconnect with Plaid" : "Connect with Plaid"}
        </button>
        <span className="site-fine">Plaid connects your account. {p.orgName} never sees your password.</span>
      </div>
      {phase === "error" && error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {phase === "saving" && (
        <p className="site-fine" role="status">
          <IconCheck /> Connected. Getting your loan details...
        </p>
      )}
      {token && phase === "linking" && <PlaidLauncher token={token} onSuccess={onSuccess} onExit={onExit} />}
    </div>
  );
}
