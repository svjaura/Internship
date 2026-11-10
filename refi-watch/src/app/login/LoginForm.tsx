"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

type Step = "password" | "checking" | "enroll" | "verify";

/**
 * Staff login: email and password, then a TOTP code from an authenticator app.
 * First login enrolls the authenticator (QR code). The dashboard requires aal2.
 */
export default function LoginForm({ supabaseUrl, anonKey, startAtMfa }: { supabaseUrl: string; anonKey: string; startAtMfa: boolean }) {
  const supabase = useMemo(() => createBrowserClient(supabaseUrl, anonKey), [supabaseUrl, anonKey]);
  const [step, setStep] = useState<Step>(startAtMfa ? "checking" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const router = useRouter();

  async function finish() {
    await fetch("/api/audit/login", { method: "POST" }).catch(() => null);
    router.replace("/dashboard");
    router.refresh();
  }

  async function goMfa() {
    setError("");
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.error) {
      setStep("password");
      return;
    }
    if (aal.data.currentLevel === "aal2") return finish();
    const factors = await supabase.auth.mfa.listFactors();
    if (factors.error) {
      setError("Could not load your two-factor settings.");
      setStep("password");
      return;
    }
    const verified = factors.data.totp.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
      setStep("verify");
      return;
    }
    // Clear any half-finished enrollment, then start a new one.
    for (const f of factors.data.all.filter((f) => f.factor_type === "totp" && f.status !== "verified")) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const en = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Refi Watch" });
    if (en.error) {
      setError("Could not start two-factor setup.");
      setStep("password");
      return;
    }
    setFactorId(en.data.id);
    const q = en.data.totp.qr_code;
    setQr(q.startsWith("data:") ? q : `data:image/svg+xml;utf-8,${encodeURIComponent(q)}`);
    setSecret(en.data.totp.secret);
    setStep("enroll");
  }

  useEffect(() => {
    if (!startAtMfa || started.current) return;
    started.current = true;
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) void goMfa();
      else setStep("password");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setPassword("");
    if (err) {
      setError("Email or password is not right.");
      setBusy(false);
      return;
    }
    await goMfa();
    setBusy(false);
  }

  async function onCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, "") });
    setCode("");
    if (err) {
      setError("That code didn't work. Codes change every 30 seconds; try the current one.");
      setBusy(false);
      return;
    }
    await finish();
  }

  return (
    <div className="card auth-card">
      <h1>Refi Watch staff login</h1>
      {step === "password" && (
        <form onSubmit={onPassword}>
          <p>Weber Mortgage staff only. You&apos;ll confirm with a code from your authenticator app next.</p>
          <label htmlFor="email">Email</label>
          <input id="email" className="text-in" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" className="text-in" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Checking..." : "Continue"}
          </button>
        </form>
      )}
      {step === "checking" && <p>Checking your session...</p>}
      {step === "enroll" && (
        <form onSubmit={onCode}>
          <p>Set up two-factor once. Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img className="qr" src={qr} alt="QR code for your authenticator app" />}
          <p>
            Can&apos;t scan? Enter this key: <span className="secret">{secret}</span>
          </p>
          <label htmlFor="code">6-digit code</label>
          <input id="code" className="text-in" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Verifying..." : "Turn on two-factor and continue"}
          </button>
        </form>
      )}
      {step === "verify" && (
        <form onSubmit={onCode}>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <label htmlFor="code">6-digit code</label>
          <input id="code" className="text-in" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Verifying..." : "Verify"}
          </button>
        </form>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
