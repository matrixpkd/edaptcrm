"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRightLeft, GripVertical, Info } from "lucide-react";
import { moveCardAction } from "@/app/(app)/pipeline/actions";
import { GradeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import type { Stage } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { allowedTargets, moveIntent, STAGE_HINTS, STAGE_TITLES } from "@/lib/pipeline/rules";
import { cn } from "@/lib/utils";

export type BoardCardView = {
  id: string;
  name: string;
  stage: Stage;
  grade: "A" | "B" | "C" | "D" | null;
  ownerName: string | null;
  nextOffer: string | null;
  ltv: string;
  purchaseCount: number;
  lostReasonLabel: string | null;
  movable: boolean;
};

export type BoardColumnView = { stage: Stage; count: number; ltv: string; cards: BoardCardView[]; moreHref: string | null };

type Pending = { card: BoardCardView; to: Stage };

/**
 * The pipeline board. Laptops drag a card onto Qualified or Lost, or a Lost card back onto any column (Reopen); every
 * card also has a Move button (phones, keyboards) offering only those moves. Lost asks for the reason first.
 */
export function PipelineBoard({ columns, lostReasons }: { columns: BoardColumnView[]; lostReasons: { value: string; label: string }[] }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<BoardCardView | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [moving, setMoving] = useState<BoardCardView | null>(null);
  const [asking, setAsking] = useState<Pending | null>(null);
  const [reason, setReason] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function canDrop(card: BoardCardView | null, to: Stage): boolean {
    return !!card && card.movable && moveIntent(card.stage, to, card.purchaseCount).kind !== "none";
  }

  function request(card: BoardCardView, to: Stage) {
    const intent = moveIntent(card.stage, to, card.purchaseCount);
    if (intent.kind === "none") {
      toast(intent.reason, "error");
      return;
    }
    if (!card.movable) {
      toast("You cannot change this contact's stage", "error");
      return;
    }
    setMoving(null);
    if (intent.kind === "lose") {
      setReason("");
      setError(null);
      setAsking({ card, to });
      return;
    }
    send(card, to, null);
  }

  function send(card: BoardCardView, to: Stage, lostReason: string | null) {
    const fd = new FormData();
    fd.set("contactId", card.id);
    fd.set("to", to);
    if (lostReason) fd.set("lostReason", lostReason);
    start(async () => {
      let r: ActionResult<{ stage: Stage }>;
      try {
        r = await moveCardAction(null, fd);
      } catch {
        r = { ok: false, error: "Could not reach the server. Check your connection and try again." };
      }
      if (r?.ok) {
        setAsking(null);
        toast(r.message ?? "Moved");
        router.refresh();
      } else if (asking || lostReason) {
        setError(r?.error ?? "Something went wrong");
      } else {
        toast(r?.error ?? "Something went wrong", "error");
      }
    });
  }

  return (
    <>
      <p className="mb-3 flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Six stages move by themselves (enquiries, logged calls, payments, referrals, time). You set only{" "}
          <strong className="text-foreground">Qualified</strong> and <strong className="text-foreground">Lost</strong>: drag a card there, or use
          Move. Drag a Lost card anywhere to reopen it.
        </span>
      </p>
      <div
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0"
        role="list"
        aria-label="Pipeline columns"
        data-testid="pipeline-board"
      >
        {columns.map((col) => {
          const droppable = canDrop(dragging, col.stage);
          return (
            <section
              key={col.stage}
              role="listitem"
              aria-label={`${STAGE_TITLES[col.stage]}: ${col.count}`}
              data-stage={col.stage}
              onDragOver={(e) => {
                if (!droppable) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== col.stage) setOver(col.stage);
              }}
              onDragLeave={() => setOver((o) => (o === col.stage ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const card = dragging;
                setDragging(null);
                if (card) request(card, col.stage);
              }}
              className={cn(
                "flex w-[82vw] max-w-[18rem] shrink-0 snap-start flex-col rounded-2xl border bg-surface-muted/60 sm:w-72",
                dragging && droppable ? "border-foreground/40 border-dashed" : "border-border",
                over === col.stage && "bg-surface-muted ring-2 ring-foreground/30",
                dragging && !droppable && "opacity-60",
              )}
            >
              <header className="border-b border-border px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold">{STAGE_TITLES[col.stage]}</h2>
                  <span className="tabular text-sm font-semibold">{col.count.toLocaleString("en-IN")}</span>
                </div>
                <p className="mt-0.5 flex justify-between gap-2 text-[11px] text-muted">
                  <span className="truncate">{STAGE_HINTS[col.stage]}</span>
                  <span className="tabular shrink-0">{col.ltv}</span>
                </p>
              </header>
              <ul className="flex max-h-[calc(100dvh-14rem)] min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2" aria-label={`${STAGE_TITLES[col.stage]} contacts`}>
                {col.cards.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted">No contacts</li>}
                {col.cards.map((card) => (
                  <li
                    key={card.id}
                    draggable={card.movable}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", card.id);
                      setDragging(card);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    className={cn(
                      "group rounded-xl border border-border bg-surface p-2.5 shadow-sm",
                      card.movable && "cursor-grab active:cursor-grabbing",
                      dragging?.id === card.id && "opacity-50",
                    )}
                    data-contact={card.id}
                  >
                    <div className="flex items-start gap-2">
                      <GradeBadge grade={card.grade} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link href={`/contacts/${card.id}`} className="block truncate text-sm font-semibold hover:underline" draggable={false}>
                          {card.name}
                        </Link>
                        <p className="truncate text-xs text-muted">{card.ownerName ?? "Pool"}</p>
                      </div>
                      {card.movable && <GripVertical className="hidden h-4 w-4 shrink-0 text-muted group-hover:block" aria-hidden />}
                    </div>
                    {card.lostReasonLabel && <p className="mt-1.5 text-xs text-danger">{card.lostReasonLabel}</p>}
                    {card.nextOffer && (
                      <p className="mt-1.5 line-clamp-2 text-xs">
                        <span className="text-muted">Next: </span>
                        {card.nextOffer}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="tabular text-xs font-medium">{card.ltv}</span>
                      {card.movable && allowedTargets(card.stage, card.purchaseCount).length > 0 && (
                        <button
                          type="button"
                          onClick={() => setMoving(card)}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-surface-muted"
                          aria-label={`Move ${card.name}`}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden /> Move
                        </button>
                      )}
                    </div>
                  </li>
                ))}
                {col.moreHref && (
                  <li>
                    <Link href={col.moreHref} className="block rounded-lg px-2 py-2 text-center text-xs font-medium text-muted hover:bg-surface hover:text-foreground">
                      All {col.count.toLocaleString("en-IN")} in Contacts →
                    </Link>
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>

      {/* while dragging: the allowed targets in a bar that stays on screen, so Lost works even when its column is
          scrolled out of view */}
      {dragging && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 flex justify-center gap-3 border-t border-border bg-surface/95 p-3 shadow-2xl backdrop-blur lg:left-60"
          role="group"
          aria-label="Drop here"
        >
          {allowedTargets(dragging.stage, dragging.purchaseCount).map((t) => (
            <div
              key={t.stage}
              data-drop={t.stage}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== t.stage) setOver(t.stage);
              }}
              onDragLeave={() => setOver((o) => (o === t.stage ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const card = dragging;
                setOver(null);
                setDragging(null);
                if (card) request(card, t.stage);
              }}
              className={cn(
                "flex h-14 min-w-36 items-center justify-center rounded-xl border-2 border-dashed px-4 text-sm font-semibold",
                t.stage === "lost" ? "border-danger/50 text-danger" : "border-foreground/40",
                over === t.stage && "bg-surface-muted",
              )}
            >
              {t.stage === "lost" ? "Lost" : t.label}
            </div>
          ))}
        </div>
      )}

      <Sheet open={!!moving} onClose={() => setMoving(null)} title={moving ? `Move ${moving.name}` : "Move"}>
        {moving && (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              Now {STAGE_TITLES[moving.stage]}. Only the stages you set by hand are offered.
            </p>
            {allowedTargets(moving.stage, moving.purchaseCount).map((t) => (
              <Button key={t.stage} variant="outline" size="lg" className="w-full justify-start" disabled={busy} onClick={() => request(moving, t.stage)}>
                {t.label}
              </Button>
            ))}
          </div>
        )}
      </Sheet>

      <Sheet open={!!asking} onClose={() => setAsking(null)} title={asking ? `Why was ${asking.card.name} lost?` : "Lost"}>
        {asking && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason) {
                setError("Choose a reason");
                return;
              }
              send(asking.card, asking.to, reason);
            }}
          >
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Lost reason">
              {lostReasons.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={reason === r.value}
                  onClick={() => setReason(r.value)}
                  className={cn(
                    "rounded-full border px-3.5 py-2 text-sm font-medium",
                    reason === r.value ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" variant="danger" disabled={busy}>
                Mark lost
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAsking(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Sheet>
    </>
  );
}
