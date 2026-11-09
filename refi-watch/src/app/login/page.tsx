import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isNoKeysMode, supabasePublic } from "@/lib/config";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Staff login · Refi Watch" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const pub = supabasePublic();
  if (isNoKeysMode() || !pub) redirect("/dashboard");
  // The anon key is public by design (it only works through RLS); the service role key never leaves the server.
  return (
    <main className="auth-wrap">
      <LoginForm supabaseUrl={pub.url} anonKey={pub.anonKey} startAtMfa={step === "mfa"} />
    </main>
  );
}
