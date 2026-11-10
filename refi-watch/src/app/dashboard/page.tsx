import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getStaff } from "@/lib/auth";
import { ORG_DISPLAY, plaidConfigured, plaidEnv } from "@/lib/config";
import { getStore } from "@/lib/db";
import { todayISO } from "@/lib/rules";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard · Refi Watch" };

export default async function DashboardPage() {
  const staff = await getStaff();
  if (!staff.ok) {
    if (staff.reason === "setup_incomplete") {
      return (
        <main className="auth-wrap">
          <div className="card auth-card">
            <h1>Setup incomplete</h1>
            <p>This deployment has no Supabase keys, and test mode is turned off in production. Add SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in Vercel, then redeploy.</p>
          </div>
        </main>
      );
    }
    if (staff.reason === "not_staff") {
      return (
        <main className="auth-wrap">
          <div className="card auth-card">
            <h1>No access</h1>
            <p>You are signed in, but this account is not on the staff list for any organization. Ask the owner to add you.</p>
            <form action="/auth/signout" method="post">
              <button className="btn btn-ghost" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </main>
      );
    }
    redirect(staff.reason === "needs_mfa" ? "/login?step=mfa" : "/login");
  }

  const data = await getStore().loadDashboard(staff.orgId);
  const asOf = data.fixedAsOf ?? todayISO(ORG_DISPLAY.timeZone);

  return (
    <Dashboard
      orgName={data.orgName}
      records={data.records}
      initialSettings={data.settings}
      initialPreset={data.preset}
      asOf={asOf}
      noKeys={staff.noKeys}
      plaidMode={plaidConfigured() ? plaidEnv() : "off"}
      staffEmail={staff.email}
      pendingInvites={data.pendingInvites.map((p) => ({ name: p.name, code: p.code }))}
    />
  );
}
