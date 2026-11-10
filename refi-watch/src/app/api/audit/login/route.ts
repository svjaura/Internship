/** POST /api/audit/login  Called once after a staff member finishes two-factor. Writes the login to the audit log. */
import { staffOrError } from "@/lib/auth";
import { getStore } from "@/lib/db";

export async function POST(request: Request) {
  const auth = await staffOrError();
  if ("response" in auth) return auth.response;
  if (auth.staff.noKeys) return Response.json({ ok: true, logged: false });
  await getStore().audit(auth.staff.orgId, auth.staff.userId, "login", {
    aal: "aal2",
    user_agent: (request.headers.get("user-agent") || "").slice(0, 200),
  });
  return Response.json({ ok: true, logged: true });
}
