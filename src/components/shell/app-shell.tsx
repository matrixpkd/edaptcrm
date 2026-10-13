"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Building2,
  Copy,
  Gauge,
  ListChecks,
  LogOut,
  Menu,
  Settings,
  Upload,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Role } from "@/db/schema";
import { navFor } from "./nav";
import { Avatar } from "@/components/ui/avatar";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { logoutAction } from "@/app/(auth)/actions";
import { CallReturnWatcher } from "@/components/contacts/call-return-watcher";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "list-checks": ListChecks,
  users: Users,
  "user-plus": UserPlus,
  wallet: Wallet,
  building: Building2,
  gauge: Gauge,
  upload: Upload,
  copy: Copy,
  settings: Settings,
};

function isActive(pathname: string, href: string) {
  if (href === "/contacts") return pathname === "/contacts" || (pathname.startsWith("/contacts/") && !pathname.startsWith("/contacts/new"));
  return pathname === href || pathname.startsWith(href + "/");
}

export function AppShell({
  user,
  unread,
  children,
}: {
  user: { name: string; email: string; role: Role };
  unread: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const items = navFor(user.role);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh lg:flex">
      <CallReturnWatcher />
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/today" aria-label="Edapt CRM home">
            <Image src="/brand/edapt-logo.png" alt="Edapt" width={96} height={27} priority />
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          {items.map((item) => {
            const Icon = ICONS[item.icon] ?? ListChecks;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                  active ? "bg-foreground text-white" : "text-foreground/80 hover:bg-surface-muted",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <Link
            href="/notifications"
            className="mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-surface-muted"
          >
            <Bell className="h-4 w-4" />
            Alerts
            {unread > 0 && (
              <span className="ml-auto rounded-full bg-danger px-1.5 text-xs font-semibold text-white">{unread}</span>
            )}
          </Link>
          <div className="flex items-center gap-2 rounded-lg px-2 py-2">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted">{ROLE_LABELS[user.role]}</p>
            </div>
            <form action={logoutAction}>
              <button className="rounded-lg p-2 text-muted hover:bg-surface-muted" aria-label="Sign out" title="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:hidden">
        <Link href="/today" aria-label="Edapt CRM home">
          <Image src="/brand/edapt-logo.png" alt="Edapt" width={80} height={22} priority />
        </Link>
        <div className="flex items-center gap-1">
          <Link href="/notifications" className="relative rounded-lg p-2 hover:bg-surface-muted" aria-label="Alerts">
            <Bell className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute right-1 top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Link>
          <button
            type="button"
            className="rounded-lg p-2 hover:bg-surface-muted"
            aria-label="Menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Phone menu drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 flex h-full w-72 flex-col bg-surface shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="text-sm font-semibold">{user.name}</span>
              <button className="rounded-lg p-2 hover:bg-surface-muted" onClick={() => setMenuOpen(false)} aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
              {items.map((item) => {
                const Icon = ICONS[item.icon] ?? ListChecks;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                      isActive(pathname, item.href) ? "bg-foreground text-white" : "hover:bg-surface-muted",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <form action={logoutAction} className="border-t border-border p-3">
              <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-surface-muted">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </form>
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-28 pt-4 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Phone bottom bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur safe-bottom lg:hidden">
        <ul className="grid grid-cols-4">
          {items
            .filter((i) => i.mobile)
            .map((item) => {
              const Icon = ICONS[item.icon] ?? ListChecks;
              const active = isActive(pathname, item.href);
              const primary = item.href === "/contacts/new";
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                      active ? "text-foreground" : "text-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full",
                        primary && "bg-foreground text-white",
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          <li>
            <Link
              href="/notifications"
              className={cn(
                "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                pathname.startsWith("/notifications") ? "text-foreground" : "text-muted",
              )}
            >
              <span className="relative flex h-8 w-8 items-center justify-center">
                <Bell className="h-5 w-5" />
                {unread > 0 && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-danger" />}
              </span>
              Alerts
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
