import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  if (await getCurrentUser()) redirect("/today");
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) redirect("/setup");
  const { next, reset } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Image src="/brand/edapt-logo.png" alt="Edapt" width={150} height={42} priority />
          <p className="text-sm text-muted">CRM · sign in to continue</p>
        </div>
        {reset && (
          <p role="status" className="mb-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
            Password changed. Sign in with your new password.
          </p>
        )}
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <LoginForm next={next} />
        </div>
        <p className="mt-4 text-center text-sm">
          <Link href="/forgot" className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline">
            Forgot password?
          </Link>
        </p>
      </div>
    </div>
  );
}
