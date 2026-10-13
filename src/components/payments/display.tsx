/**
 * Read-only bits shared by the payment screens: amounts with their INR value, proof thumbnails and
 * status badges. No client code: safe in server components.
 */
import { FileText, ImageIcon } from "lucide-react";
import type { PaymentStatus, PurchaseStatus } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import {
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUS_TONE,
  formatAmount,
} from "@/components/contacts/labels";
import { cn, formatINR } from "@/lib/utils";
import { isPdf, isPreviewableImage } from "./rules";

/** "AED 1,500" with "₹34,050" under it; INR amounts show once. */
export function Money({
  amount,
  currency,
  inr,
  className,
  strong = true,
}: {
  amount: number;
  currency: string;
  inr?: number | null;
  className?: string;
  strong?: boolean;
}) {
  const foreign = currency !== "INR";
  return (
    <span className={cn("tabular inline-flex flex-col leading-tight", className)}>
      <span className={strong ? "font-medium" : undefined}>{formatAmount(amount, currency)}</span>
      {foreign && inr != null && <span className="text-xs text-muted">{formatINR(inr)}</span>}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={PAYMENT_STATUS_TONE[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return <Badge tone={PURCHASE_STATUS_TONE[status]}>{PURCHASE_STATUS_LABELS[status]}</Badge>;
}

/**
 * A proof: an image thumbnail (screenshots), a PDF tile, or "No proof". Opens the file in a new tab
 * (files are served by /api/files, which checks the session).
 */
export function ProofThumb({
  url,
  label = "Payment proof",
  size = "md",
}: {
  url: string | null | undefined;
  label?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dims = size === "lg" ? "h-40 w-full max-w-xs" : size === "sm" ? "h-10 w-10" : "h-14 w-14";
  if (!url) {
    return size === "lg" ? (
      <p className="text-sm text-muted">No proof attached.</p>
    ) : (
      <span className="text-xs text-muted">No proof</span>
    );
  }
  const image = isPreviewableImage(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${label.toLowerCase()}`}
      aria-label={`Open ${label.toLowerCase()} in a new tab`}
      className={cn(
        "group inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-muted text-muted hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dims,
      )}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- private files behind the session; next/image cannot optimise them
        <img src={url} alt={label} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex flex-col items-center gap-0.5 text-[10px] font-semibold uppercase">
          {isPdf(url) ? <FileText className="h-5 w-5" aria-hidden /> : <ImageIcon className="h-5 w-5" aria-hidden />}
          {isPdf(url) ? "PDF" : "File"}
        </span>
      )}
    </a>
  );
}

/** A labelled value in a definition list. */
export function Fact({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
