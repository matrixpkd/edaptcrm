import type { Stage } from "@/db/schema";
import { TASK_TYPE_LABELS, type QueueBand, type QueueKind, type QueueRow } from "@/lib/today/rank";

/** What a Today row component needs: plain strings and numbers only (safe to pass to a client component). */
export type QueueRowView = {
  key: string;
  taskIds: string[];
  band: QueueBand;
  kind: QueueKind;
  typeLabel: string;
  /** labels of the other task types on the row */
  extraTypeLabels: string[];
  reason: string;
  alsoReasons: string[];
  context: string[];
  contact: {
    id: string;
    name: string;
    phoneE164: string;
    grade: "A" | "B" | "C" | "D" | null;
    edaptScore: number | null;
    stage: Stage;
    nextOffer: string | null;
  } | null;
  pool: boolean;
  canDismiss: boolean;
  transferTaskId: string | null;
};

export function toRowView(row: QueueRow): QueueRowView {
  const c = row.contact;
  return {
    key: row.key,
    taskIds: row.taskIds,
    band: row.band,
    kind: row.kind,
    typeLabel: row.band === "overdue" ? "Overdue follow-up" : TASK_TYPE_LABELS[row.primary.type],
    extraTypeLabels: row.types.filter((t) => t !== row.primary.type).map((t) => TASK_TYPE_LABELS[t]),
    reason: row.reason,
    alsoReasons: row.alsoReasons,
    context: row.context,
    contact: c
      ? {
          id: c.id,
          name: c.name,
          phoneE164: c.phoneE164,
          grade: c.grade,
          edaptScore: c.edaptScore,
          stage: c.stage,
          nextOffer: c.nextOffer,
        }
      : null,
    pool: row.pool,
    canDismiss: row.canDismiss,
    transferTaskId: row.transferTaskId,
  };
}
