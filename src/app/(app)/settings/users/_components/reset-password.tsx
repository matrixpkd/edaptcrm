"use client";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { FormSubmit, SettingsForm } from "../../_components/settings-form";
import { TempPassword } from "../../_components/temp-password";
import { resetPasswordAction } from "../actions";

/** Resets someone's password and shows the new temporary one once. */
export function ResetPassword({ id, name }: { id: string; name: string }) {
  const [password, setPassword] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {password && <TempPassword password={password} who={name} />}
      <SettingsForm<{ tempPassword: string }>
        action={resetPasswordAction}
        confirm={`Reset ${name}'s password? Their current password stops working and they are signed out everywhere.`}
        onSuccess={(s) => {
          if (s?.ok && s.data) setPassword(s.data.tempPassword);
        }}
        aria-label="Reset password"
      >
        <input type="hidden" name="id" value={id} />
        <FormSubmit variant="outline" pendingText="Resetting…">
          <KeyRound className="h-4 w-4" aria-hidden /> {password ? "Reset again" : "Reset password"}
        </FormSubmit>
      </SettingsForm>
    </div>
  );
}
