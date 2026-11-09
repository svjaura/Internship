/**
 * POST /api/invites  { fullName, email? }  Staff only.
 * Creates a borrower and returns the connect link. Nothing is sent: staff
 * share the link themselves (no automatic texts or emails to borrowers).
 */
import { staffOrError } from "@/lib/auth";
import { getStore } from "@/lib/db";

export async function POST(request: Request) {
  const auth = await staffOrError();
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => null)) as { fullName?: unknown; email?: unknown } | null;
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  const emailRaw = typeof body?.email === "string" ? body.email.trim() : "";
  if (!fullName || fullName.length > 120) return Response.json({ error: "name_required" }, { status: 400 });
  if (emailRaw && (emailRaw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))) return Response.json({ error: "bad_email" }, { status: 400 });

  const store = getStore();
  const { code } = await store.createInvite(auth.staff.orgId, fullName, emailRaw || null);
  await store.audit(auth.staff.orgId, auth.staff.userId, "invite_created", {});
  const origin = new URL(request.url).origin;
  return Response.json({ code, url: `${origin}/connect/${code}` });
}
