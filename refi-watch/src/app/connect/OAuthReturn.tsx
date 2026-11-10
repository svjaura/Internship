"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { PlaidLinkOnExit, PlaidLinkOnSuccess } from "react-plaid-link";
import { OAUTH_STORE_KEY } from "./ConnectFlow";
import PlaidLauncher from "./PlaidLauncher";

type Saved = { token: string; invite: string } | null;

function readSaved(): string {
  try {
    return sessionStorage.getItem(OAUTH_STORE_KEY) || "";
  } catch {
    return "";
  }
}
const noop = () => () => {};

/** Re-opens Plaid Link with the same link token after the borrower comes back from their bank. */
export default function OAuthReturn({ contactFirstName, phone }: { contactFirstName: string; phone: string }) {
  const raw = useSyncExternalStore(noop, readSaved, () => "");
  const saved: Saved = useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  }, [raw]);
  // save_error: Plaid Link finished (the connection exists) but our save failed. Never ask to connect
  // again then: a second connection would use another Trial slot. The borrower calls; we recover it.
  const [phase, setPhase] = useState<"linking" | "saving" | "done" | "error" | "save_error">("linking");
  const href = typeof window !== "undefined" ? window.location.href : undefined;

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      if (!saved) return;
      setPhase("saving");
      const res = await fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: saved.invite, public_token: publicToken, institution_name: metadata.institution?.name ?? null }),
      }).catch(() => null);
      try {
        sessionStorage.removeItem(OAUTH_STORE_KEY);
      } catch {}
      setPhase(res && (res.ok || res.status === 409) ? "done" : "save_error");
    },
    [saved],
  );
  const onExit = useCallback<PlaidLinkOnExit>(() => setPhase("error"), []);

  if (phase === "done") {
    return (
      <>
        <h1 className="site-h">You&apos;re connected.</h1>
        <p className="site-lead">Your mortgage is connected. Your password stayed with Plaid and your bank. You can close this page.</p>
      </>
    );
  }
  if (phase === "save_error") {
    return (
      <>
        <h1 className="site-h">Almost done</h1>
        <p className="site-lead">
          Your servicer connected, but we couldn&apos;t finish saving it. Please don&apos;t connect again: call {contactFirstName} at{" "}
          <a href={`tel:${phone.replace(/[^0-9]/g, "")}`}>{phone}</a> and we&apos;ll finish it for you.
        </p>
      </>
    );
  }
  if (!saved || phase === "error") {
    return (
      <>
        <h1 className="site-h">Let&apos;s try that again</h1>
        <p className="site-lead">The connection didn&apos;t finish. Please open the link we sent you again and press Connect with Plaid.</p>
      </>
    );
  }
  return (
    <>
      <h1 className="site-h">Finishing your connection...</h1>
      <p className="site-lead">{phase === "saving" ? "Getting your loan details." : "Returning to Plaid."}</p>
      {href && <PlaidLauncher token={saved.token} receivedRedirectUri={href} onSuccess={onSuccess} onExit={onExit} />}
    </>
  );
}
