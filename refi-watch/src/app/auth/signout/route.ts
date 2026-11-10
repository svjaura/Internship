/** POST /auth/signout  Ends the staff session and returns to the login page. */
import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/config";
import { createAuthClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  if (supabaseConfigured()) {
    const supabase = await createAuthClient();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
