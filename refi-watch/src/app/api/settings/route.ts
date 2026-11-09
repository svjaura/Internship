/** PUT /api/settings  { settings, preset }  Staff only. Saves the rule, today's rate and closing costs. */
import { staffOrError } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { isPresetId, sanitizeSettings } from "@/lib/rules";

export async function PUT(request: Request) {
  const auth = await staffOrError();
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => null)) as { settings?: unknown; preset?: unknown } | null;
  const settings = sanitizeSettings(body?.settings);
  const preset = isPresetId(body?.preset) ? body.preset : null;
  if (!settings || !preset) return Response.json({ error: "invalid_settings" }, { status: 400 });
  const store = getStore();
  await store.saveSettings(auth.staff.orgId, settings, preset, auth.staff.userId);
  await store.audit(auth.staff.orgId, auth.staff.userId, "settings_update", { ...settings, preset });
  return Response.json({ ok: true });
}
