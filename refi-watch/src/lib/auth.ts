/**
 * Staff authorization. Server only.
 *
 * Live mode: a Supabase session that passed TOTP two-factor (aal2) and a row in
 * staff_members. Checked here on every staff page and API call, not only in the
 * proxy, so a proxy bypass does not open the data.
 *
 * No-keys mode: bypassed (demo data only), never on a Vercel production deployment.
 */
import "server-only";
import { isNoKeysMode, noKeysModeAllowed } from "./config";
import { DEMO_ORG_ID, getStore } from "./db";
import { createAuthClient } from "./supabase/server";

export type StaffContext =
  | { ok: true; orgId: string; userId: string | null; email: string | null; noKeys: boolean }
  | { ok: false; reason: "no_session" | "needs_mfa" | "not_staff" | "setup_incomplete" };

export async function getStaff(): Promise<StaffContext> {
  if (isNoKeysMode()) {
    if (!noKeysModeAllowed()) return { ok: false, reason: "setup_incomplete" };
    return { ok: true, orgId: DEMO_ORG_ID, userId: null, email: null, noKeys: true };
  }
  const supabase = await createAuthClient();
  // getClaims() verifies the JWT (signature and expiry), unlike getSession().
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return { ok: false, reason: "no_session" };
  if (claims.aal !== "aal2") return { ok: false, reason: "needs_mfa" };
  const membership = await getStore().getStaffOrg(claims.sub);
  if (!membership) return { ok: false, reason: "not_staff" };
  return { ok: true, orgId: membership.orgId, userId: claims.sub, email: typeof claims.email === "string" ? claims.email : null, noKeys: false };
}

/** For API routes: a JSON error response when the caller is not signed-in staff with two-factor. */
export async function staffOrError(): Promise<{ staff: Extract<StaffContext, { ok: true }> } | { response: Response }> {
  const ctx = await getStaff();
  if (ctx.ok) return { staff: ctx };
  const status = ctx.reason === "setup_incomplete" ? 503 : ctx.reason === "not_staff" ? 403 : 401;
  return { response: Response.json({ error: ctx.reason }, { status }) };
}
