/**
 * Staff gate for /dashboard (Next.js 16 "proxy", formerly middleware).
 *
 * Live mode: refreshes the Supabase session cookie, then requires a verified
 * session at aal2 (TOTP two-factor). Otherwise redirects to /login.
 * No-keys mode (no Supabase env vars): lets the request through; the page shows
 * a "test mode" banner. On a Vercel production deployment the page refuses instead.
 *
 * The dashboard page and every staff API route check again on the server
 * (src/lib/auth.ts), so this is not the only line of defense.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub || claims.aal !== "aal2") {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = claims?.sub ? "?step=mfa" : "";
    const redirect = NextResponse.redirect(login);
    // Carry any refreshed auth cookies over to the redirect.
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
