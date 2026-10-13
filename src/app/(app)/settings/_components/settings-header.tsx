import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/card";

/** Page title with a "Settings" back link, used by every Settings screen. */
export function SettingsHeader({
  title,
  description,
  actions,
  backHref = "/settings",
  backLabel = "Settings",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <PageHeader
      back={
        <Link href={backHref} className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {backLabel}
        </Link>
      }
      title={title}
      description={description}
      actions={actions}
    />
  );
}
