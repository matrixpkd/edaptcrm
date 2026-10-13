import "server-only";
import { ROLES } from "@/db/schema";
import { ROLE_LABELS } from "@/lib/auth/permissions";

const COMMON_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Asia/Qatar", "Asia/Kuwait", "Asia/Bahrain", "Asia/Muscat"];

let zones: { value: string; label: string }[] | null = null;

/** Time zones for a native select: the ones Edapt uses first, then every zone the runtime knows. */
export function timeZoneOptions(): { value: string; label: string }[] {
  if (!zones) {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = [];
    }
    const rest = all.filter((z) => !COMMON_ZONES.includes(z));
    zones = [...COMMON_ZONES, ...rest].map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
  }
  return zones;
}

export const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

export const ROLE_HELP: Record<(typeof ROLES)[number], string> = {
  admin: "Everything, plus settings, imports and exports",
  manager: "All contacts; reassigns owners and verifies payments",
  sales: "Own contacts and the pool; adds leads, logs calls, records payments",
  support: "All contacts; logs support issues and notes, never owns",
};
