import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Full-screen sheet for the phone-first forms (Log interaction, Rate customer): on phones it covers the app
 * shell with its own header and a pinned footer; from lg up it is a centred card in the page.
 */
export function ScreenSheet({
  title,
  subtitle,
  closeHref,
  headerExtra,
  wide = false,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  closeHref: string;
  headerExtra?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="sheet-title"
      className={cn(
        "fixed inset-0 z-40 flex flex-col bg-surface",
        "lg:static lg:z-auto lg:mx-auto lg:rounded-2xl lg:border lg:border-border lg:shadow-sm",
        wide ? "lg:max-w-4xl" : "lg:max-w-xl",
      )}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-2 py-2 sm:px-4">
        <Link
          href={closeHref}
          aria-label="Close"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-5 w-5" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 id="sheet-title" className="truncate text-base font-semibold leading-tight">
            {title}
          </h1>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        {headerExtra && <div className="shrink-0">{headerExtra}</div>}
      </header>
      {children}
    </section>
  );
}
