import type { ImportStatus } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "@/lib/import/types";

const TONE: Record<ImportStatus, "neutral" | "info" | "warning" | "success" | "danger" | "brand"> = {
  uploaded: "neutral",
  mapped: "neutral",
  cleaned: "neutral",
  matched: "info",
  committing: "warning",
  committed: "success",
  undone: "neutral",
  failed: "danger",
};

export function BatchStatusBadge({ status, undoing }: { status: string; undoing?: boolean }) {
  if (undoing) return <Badge tone="warning">Undoing</Badge>;
  const s = status as ImportStatus;
  return <Badge tone={TONE[s] ?? "neutral"}>{STATUS_LABELS[s] ?? status}</Badge>;
}
