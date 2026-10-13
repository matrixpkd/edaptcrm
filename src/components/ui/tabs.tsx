import Link from "next/link";
import { cn } from "@/lib/utils";

/** Link-based tabs; the active tab is decided by the page (e.g. from searchParams). */
export function Tabs({
  tabs,
  active,
  className,
}: {
  tabs: { key: string; label: React.ReactNode; href: string; count?: number }[];
  active: string;
  className?: string;
}) {
  return (
    <nav className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)} aria-label="Tabs">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              scroll={false}
              aria-current={t.key === active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                t.key === active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t.label}
              {t.count != null && <span className="rounded-full bg-surface-muted px-1.5 text-xs text-muted">{t.count}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
