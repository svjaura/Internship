import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_VARS, checkEnv } from "../env-check";

const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref: "abcd" })).toString("base64url")}.c2lnbmF0dXJl`;

/** A complete, correct production setup. Every value is distinctive so leaks are easy to spot. */
const good = () => ({
  PLAID_CLIENT_ID: "client-id-VALUE-1",
  PLAID_SECRET_SANDBOX: "sandbox-secret-VALUE-2",
  PLAID_SECRET_PRODUCTION: "prod-secret-VALUE-3",
  PLAID_ENV: "production",
  PLAID_WEBHOOK_URL: "https://refi-watch.vercel.app/api/plaid/webhook",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_VALUE-4",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_VALUE-5",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  BORROWER_REFI_VIEW: "false",
});
const errors = (env: Record<string, string | undefined>) => checkEnv(env).checks.filter((c) => c.level === "error").map((c) => `${c.key}: ${c.message}`);
const warns = (env: Record<string, string | undefined>) => checkEnv(env).checks.filter((c) => c.level === "warn").map((c) => `${c.key}: ${c.message}`);

describe("checkEnv", () => {
  it("passes a complete setup and never returns a value", () => {
    const env = good();
    const r = checkEnv(env);
    expect(r.ok).toBe(true);
    expect(r.plaidEnv).toBe("production");
    expect(errors(env)).toEqual([]);
    expect(warns(env)).toEqual([]);
    const out = JSON.stringify(r);
    for (const v of Object.values(env)) if (v.length > 5 && v !== "production") expect(out).not.toContain(v);
    expect(Object.keys(r.present).sort()).toEqual([...ENV_VARS].sort());
    expect(Object.values(r.present).every((v) => typeof v === "boolean")).toBe(true);
  });

  it("also accepts legacy JWT anon / service_role keys", () => {
    expect(checkEnv({ ...good(), SUPABASE_ANON_KEY: jwt("anon"), SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }).ok).toBe(true);
  });

  it("names every missing required variable; nothing set is not ready", () => {
    const r = checkEnv({});
    expect(r.ok).toBe(false);
    expect(r.plaidEnv).toBe("unset");
    for (const k of ["PLAID_CLIENT_ID", "PLAID_ENV", "PLAID_WEBHOOK_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY"]) {
      expect(errors({})).toContain(`${k}: not set`);
    }
  });

  it("TOKEN_ENCRYPTION_KEY must decode to 32 bytes", () => {
    expect(errors({ ...good(), TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64") }).join()).toMatch(/TOKEN_ENCRYPTION_KEY: must decode to 32 bytes \(got 16\)/);
    expect(errors({ ...good(), TOKEN_ENCRYPTION_KEY: "not base64!!" }).join()).toMatch(/TOKEN_ENCRYPTION_KEY: must be base64/);
    expect(errors({ ...good(), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex") }).join()).toMatch(/looks like hex.*openssl rand -base64 32/);
  });

  it("PLAID_ENV must be exactly sandbox or production, with that environment's secret", () => {
    expect(checkEnv({ ...good(), PLAID_ENV: "Production" }).plaidEnv).toBe("invalid");
    expect(errors({ ...good(), PLAID_ENV: "development" }).join()).toMatch(/PLAID_ENV: must be exactly/);
    expect(errors({ ...good(), PLAID_SECRET_PRODUCTION: "" })).toContain("PLAID_SECRET_PRODUCTION: not set: it's the secret used while PLAID_ENV=production");
    expect(warns({ ...good(), PLAID_ENV: "sandbox", PLAID_SECRET_PRODUCTION: "" })).toContain("PLAID_SECRET_PRODUCTION: not set: needed when PLAID_ENV switches to production");
    expect(errors({ ...good(), PLAID_SECRET_PRODUCTION: "same", PLAID_SECRET_SANDBOX: "same" }).join()).toMatch(/same as PLAID_SECRET_SANDBOX/);
    expect(warns({ ...good(), PLAID_SECRET: "x" }).join()).toMatch(/PLAID_SECRET: overrides/);
  });

  it("PLAID_WEBHOOK_URL must be https and end with /api/plaid/webhook", () => {
    for (const bad of [
      "http://refi-watch.vercel.app/api/plaid/webhook",
      "https://refi-watch.vercel.app/api/plaid/webhook/",
      "https://refi-watch.vercel.app/api/plaid",
      "https://refi-watch.vercel.app/api/plaid/webhook?x=1",
      "refi-watch.vercel.app/api/plaid/webhook",
      "https://localhost/api/plaid/webhook",
    ]) {
      expect(errors({ ...good(), PLAID_WEBHOOK_URL: bad }).some((e) => e.startsWith("PLAID_WEBHOOK_URL:"))).toBe(true);
    }
    expect(warns({ ...good(), PLAID_WEBHOOK_URL: "https://refi-watch-git-main-team.vercel.app/api/plaid/webhook" }).join()).toMatch(/preview deployment/);
  });

  it("SUPABASE_URL must be the bare https project URL; PLAID_REDIRECT_URI must end with /connect/oauth", () => {
    expect(errors({ ...good(), SUPABASE_URL: "https://abcd.supabase.co/rest/v1" }).join()).toMatch(/SUPABASE_URL: must be the project URL only/);
    expect(errors({ ...good(), SUPABASE_URL: "abcd.supabase.co" }).join()).toMatch(/SUPABASE_URL: must be an https URL/);
    expect(errors({ ...good(), PLAID_REDIRECT_URI: "https://refi-watch.vercel.app/oauth" }).join()).toMatch(/PLAID_REDIRECT_URI/);
    expect(checkEnv({ ...good(), PLAID_REDIRECT_URI: "https://refi-watch.vercel.app/connect/oauth" }).ok).toBe(true);
  });

  it("catches the Supabase keys swapped or pasted twice (the anon key goes to the browser)", () => {
    expect(errors({ ...good(), SUPABASE_ANON_KEY: "sb_secret_x" }).join()).toMatch(/SUPABASE_ANON_KEY: is a secret/);
    expect(errors({ ...good(), SUPABASE_ANON_KEY: jwt("service_role"), SUPABASE_SERVICE_ROLE_KEY: jwt("anon") }).length).toBe(2);
    expect(errors({ ...good(), SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_VALUE-4" }).join()).toMatch(/same as SUPABASE_ANON_KEY/);
  });

  it("warns when the borrower refinance view is on", () => {
    expect(warns({ ...good(), BORROWER_REFI_VIEW: "true" }).join()).toMatch(/BORROWER_REFI_VIEW: is ON/);
    expect(checkEnv({ ...good(), BORROWER_REFI_VIEW: "true" }).ok).toBe(true);
  });
});

describe("GET /api/health", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reports presence as booleans and PLAID_ENV, without any value", async () => {
    const env = good();
    Object.assign(process.env, env);
    const { GET } = await import("../../app/api/health/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, plaid_env: "production", mode: "live", problems: [] });
    expect(body.env.PLAID_CLIENT_ID).toBe(true);
    expect(body.env.PLAID_REDIRECT_URI).toBe(false);
    const text = JSON.stringify(body);
    for (const v of Object.values(env)) if (v.length > 5 && v !== "production") expect(text).not.toContain(v);
  });

  it("answers 503 with the problems named when setup is incomplete", async () => {
    for (const k of ENV_VARS) delete process.env[k];
    process.env.PLAID_ENV = "sandbox";
    process.env.TOKEN_ENCRYPTION_KEY = "short";
    const { GET } = await import("../../app/api/health/route");
    const res = GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.mode).toBe("local-test");
    expect(body.problems).toContain("SUPABASE_URL: not set");
    expect(body.problems.join()).toMatch(/TOKEN_ENCRYPTION_KEY: must decode to 32 bytes/);
    expect(JSON.stringify(body)).not.toContain('"short"');
  });
});
