import Image from "next/image";
import { redirect } from "next/navigation";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/today");
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) redirect("/setup");
  const { next } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Image src="/brand/edapt-logo.png" alt="Edapt" width={150} height={42} priority />
          <p className="text-sm text-muted">CRM · sign in to continue</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <LoginForm next={next} />
        </div>
      </div>
    </div>
  );
}
