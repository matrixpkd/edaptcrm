import Link from "next/link";
import { checkResetToken, RESET_REFUSALS } from "@/lib/auth/password-reset";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/account";
import { AuthCard } from "../_components/auth-card";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

/** Where an emailed "forgot password" link lands. The token stays in the form; it is checked again on submit. */
export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const state = await checkResetToken(token);
  return (
    <AuthCard
      subtitle="Choose a new password"
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {state.ok ? (
        <div className="space-y-4">
          <p className="text-sm">
            For <span className="font-medium">{state.email}</span>. You will be signed out everywhere and can sign in with the new password.
          </p>
          <ResetForm token={token!} minLength={MIN_PASSWORD_LENGTH} />
        </div>
      ) : (
        <div className="space-y-4">
          <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {RESET_REFUSALS[state.reason]}
          </p>
          <Link href="/forgot" className="block text-center text-sm font-medium underline-offset-2 hover:underline">
            Ask for a new link
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
