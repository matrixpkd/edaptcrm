import type { Role } from "@/db/schema";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  roles: Role[];
  /** shown in the phone bottom bar */
  mobile?: boolean;
};

const ALL: Role[] = ["admin", "manager", "sales", "support"];

/** Every screen in the app. Pages enforce their own access too; this only hides links. */
export const NAV: NavItem[] = [
  { href: "/today", label: "Today", icon: "list-checks", roles: ALL, mobile: true },
  { href: "/contacts", label: "Contacts", icon: "users", roles: ALL, mobile: true },
  { href: "/contacts/new", label: "Quick Add", icon: "user-plus", roles: ALL, mobile: true },
  { href: "/tasks", label: "Tasks", icon: "list-todo", roles: ALL },
  { href: "/pipeline", label: "Pipeline", icon: "kanban", roles: ["admin", "manager", "sales"] },
  { href: "/payments", label: "Payments", icon: "wallet", roles: ["admin", "manager", "sales"] },
  { href: "/organisations", label: "Organisations", icon: "building", roles: ALL },
  { href: "/dashboard", label: "Dashboard", icon: "gauge", roles: ["admin", "manager"] },
  { href: "/team", label: "Team", icon: "users-round", roles: ["admin", "manager"] },
  { href: "/activity", label: "Activity", icon: "activity", roles: ["admin", "manager"] },
  { href: "/import", label: "Import", icon: "upload", roles: ["admin"] },
  { href: "/duplicates", label: "Duplicates", icon: "copy", roles: ["admin", "manager"] },
  { href: "/settings", label: "Settings", icon: "settings", roles: ["admin"] },
];

export function navFor(role: Role) {
  return NAV.filter((n) => n.roles.includes(role));
}
