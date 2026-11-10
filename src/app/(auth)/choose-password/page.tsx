import { MIN_PASSWORD_LENGTH } from "@/lib/auth/account";
import { requirePasswordChoice } from "@/lib/auth/session";
import { AuthCard } from "../_components/auth-card";
import { logoutAction } from "../actions";
import { ChoosePasswordForm } from "./choose-password-form";

export const metadata = { title: "Choose your password" };
export const dynamic = "force-dynamic";

/**
 * Where someone lands after signing in with an admin's temporary password, and where every signed-in page sends
 * them until they choose their own (src/lib/auth/session.ts). Signing out still works from here.
 */
export default async function ChoosePasswordPage() {
  const user = await requirePasswordChoice();
  const first = user.name.trim().split(/\s+/)[0] || user.name;
  return (
    <AuthCard
      subtitle="Choose your password"
      footer={
        <form action={logoutAction} className="flex items-center justify-center gap-1">
          <span>Not you?</span>
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded px-2 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign out
          </button>
        </form>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1 text-sm">
          <p>
            Hi {first}. You signed in with a temporary password. Choose your own to continue.
          </p>
          <p className="break-words text-muted">
            Signed in as <span className="text-foreground">{user.email}</span>
          </p>
        </div>
        <ChoosePasswordForm email={user.email} minLength={MIN_PASSWORD_LENGTH} />
      </div>
    </AuthCard>
  );
}
