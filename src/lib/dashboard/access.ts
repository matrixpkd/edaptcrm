/**
 * Who sees the cockpit. PURE (safe in client components).
 * - The dashboard: admins and managers (permission "dashboard.view"; spec: "Dashboard | Umer, manager").
 * - The calibration report: admins only ("settings.manage"), since it exists to tune the scoring weights that only
 *   an admin can edit. Managers see the team dashboard; admins see everything.
 */
import type { Role } from "@/db/schema";
import { can } from "@/lib/auth/permissions";

export function canViewDashboard(user: { role: Role } | null | undefined): boolean {
  return can(user, "dashboard.view");
}

export function canViewCalibration(user: { role: Role } | null | undefined): boolean {
  return can(user, "dashboard.view") && can(user, "settings.manage");
}
