import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { emailResetAvailable } from "@/lib/auth/password-reset";
import { AuthCard } from "../_components/auth-card";
import { ForgotForm } from "./forgot-form";

export const metadata = { title: "Forgot password" };
export const dynamic = "force-dynamic";

export default async function ForgotPage() {
  if (await getCurrentUser()) redirect("/account");
  const byEmail = emailResetAvailable();
  return (
    <AuthCard
      subtitle="Forgot your password?"
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-4">
        {byEmail && (
          <>
            <p className="text-sm">Enter the email you sign in with and we will send you a link to choose a new password.</p>
            <ForgotForm />
            <hr className="border-border" />
          </>
        )}
        <div className="space-y-2 text-sm">
          <p className="font-medium">{byEmail ? "No email arriving?" : "Ask an admin to reset it"}</p>
          <p className="text-muted">
            An admin can give you a new temporary password: <span className="text-foreground">Team → your name → Reset password</span>. Sign in with
            it, then choose your own under <span className="text-foreground">Your account</span>.
          </p>
        </div>
      </div>
    </AuthCard>
  );
}
