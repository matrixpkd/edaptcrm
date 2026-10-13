"use client";
import { BellRing } from "lucide-react";
import { runAlertsNowAction } from "@/lib/alerts/actions";
import { FormSubmit, SettingsForm } from "../_components/settings-form";

/** "Run alerts now": every alert rule once, instead of waiting for the next scheduled run. Safe to repeat. */
export function RunAlertsButton() {
  return (
    <SettingsForm action={runAlertsNowAction} aria-label="Run alerts now">
      <FormSubmit variant="outline" pendingText="Running…">
        <BellRing className="h-4 w-4" aria-hidden /> Run alerts now
      </FormSubmit>
    </SettingsForm>
  );
}
