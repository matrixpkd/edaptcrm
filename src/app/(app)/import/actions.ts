"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PAYMENT_MODES, type PaymentMode } from "@/db/schema";
import { bool, fail, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { ContactError } from "@/lib/contacts/errors";
import {
  changeSheet,
  createImportBatch,
  discardBatch,
  getBatchView,
  ImportError,
  ImportFileError,
  resolveAllConflictsAsNew,
  resolveConflict,
  runCleanChunk,
  saveMapping,
  setRowsSkipped,
  type MappingInput,
  type PhaseResult,
} from "@/lib/import/batches";
import { runCommitChunk, startCommit } from "@/lib/import/commit";
import { runMatchChunk } from "@/lib/import/match";
import type { ProductChoice } from "@/lib/import/types";
import { runUndoChunk, startUndo } from "@/lib/import/undo";
import { isMoneyError } from "@/lib/money/errors";
import { isUuid } from "@/lib/utils";

/** The signed-in admin, or null (every action checks; never trust the client). */
async function importer(): Promise<SessionUser | null> {
  const user = await requireUser();
  return can(user, "import.run") ? user : null;
}

const DENIED = "Only an admin can run imports.";

function actionError(e: unknown): ActionResult<never> {
  if (e instanceof ImportError || e instanceof ImportFileError || e instanceof ContactError || isMoneyError(e)) return fail(e.message);
  console.error("[import] action failed", e);
  return fail("Something went wrong. Try again; if it keeps happening, check the server log.");
}

function refresh(batchId?: string) {
  revalidatePath("/import");
  if (batchId) revalidatePath(`/import/${batchId}`);
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

export async function uploadImportAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const file = fd.get("file");
  const source = str(fd, "source");
  if (!source) return fail("Choose where the file comes from.", { source: "Choose a source" });
  if (!(file instanceof File) || file.size === 0) return fail("Choose a file to upload.", { file: "Choose a file" });
  let batchId: string;
  try {
    batchId = await createImportBatch(
      { fileName: file.name, fileType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), source },
      user,
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  redirect(`/import/${batchId}`);
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

export async function changeSheetAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  const sheet = str(fd, "sheet");
  if (!isUuid(batchId) || !sheet) return fail("Choose a sheet.");
  try {
    await changeSheet(batchId, sheet, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(batchId);
  return ok(undefined, `Now reading the sheet "${sheet}". Check the mapping below.`);
}

export async function saveMappingAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  if (!isUuid(batchId)) return fail("Import not found.");
  const batch = await getBatchView(batchId, user);
  if (!batch) return fail("Import not found.");
  const headers = batch.settings.file.headers;
  // columns are posted by position, so any header text (dots, brackets, quotes) is safe
  const mapping: Record<string, string> = {};
  headers.forEach((h, i) => {
    mapping[h] = str(fd, `col_${i}`) ?? "ignore";
  });
  const productMap: Record<string, ProductChoice> = {};
  for (let i = 0; i < 500; i++) {
    const key = str(fd, `prodKey_${i}`);
    if (key === null) break;
    const choice = str(fd, `prod_${i}`);
    if (choice?.startsWith("p:")) productMap[key] = { productId: choice.slice(2) };
    else if (choice?.startsWith("f:")) productMap[key] = { family: choice.slice(2) };
  }
  const paymentMode = str(fd, "paymentMode");
  const tags = [...fd.getAll("tags"), ...(str(fd, "extraTags") ?? "").split(",")]
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean);
  const input: MappingInput = {
    mapping,
    defaults: {
      firstDoor: str(fd, "firstDoor"),
      campaign: str(fd, "campaign"),
      tags,
      tagWithCampaign: bool(fd, "tagWithCampaign"),
      defaultCountry: str(fd, "defaultCountry") ?? "IN",
      ownerFallback: str(fd, "ownerFallback") ?? "pool",
      ownerFromFile: bool(fd, "ownerFromFile"),
      recordsDate: str(fd, "recordsDate"),
      dayFirst: str(fd, "dateOrder") !== "month_first",
      currency: str(fd, "currency") ?? "INR",
      paymentMode: (PAYMENT_MODES as readonly string[]).includes(paymentMode ?? "") ? (paymentMode as PaymentMode) : "other",
      verified: bool(fd, "verified"),
      productFamily: str(fd, "productFamily"),
      productMap,
    },
  };
  try {
    await saveMapping(batchId, input, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(batchId);
  redirect(`/import/${batchId}`);
}

// ---------------------------------------------------------------------------
// Steps 3, 4, 6 and undo: one chunk per call (the screen loops until finished)
// ---------------------------------------------------------------------------

const PHASES = ["clean", "match", "commit", "undo"] as const;
export type ImportPhase = (typeof PHASES)[number];

export async function runImportPhaseAction(batchId: string, phase: ImportPhase): Promise<ActionResult<PhaseResult>> {
  const user = await importer();
  if (!user) return fail(DENIED);
  if (!isUuid(batchId) || !PHASES.includes(phase)) return fail("Import not found.");
  try {
    const res =
      phase === "clean"
        ? await runCleanChunk(batchId, user, { timeZone: user.timezone })
        : phase === "match"
          ? await runMatchChunk(batchId, user)
          : phase === "commit"
            ? await runCommitChunk(batchId, user)
            : await runUndoChunk(batchId, user);
    if (res.finished) {
      refresh(batchId);
      if (phase === "commit" || phase === "undo") {
        revalidatePath("/contacts");
        revalidatePath("/today");
      }
    }
    return ok(res);
  } catch (e) {
    return actionError(e);
  }
}

export async function startCommitAction(batchId: string): Promise<ActionResult<number>> {
  const user = await importer();
  if (!user) return fail(DENIED);
  if (!isUuid(batchId)) return fail("Import not found.");
  try {
    const n = await startCommit(batchId, user);
    return ok(n);
  } catch (e) {
    return actionError(e);
  }
}

export async function startUndoAction(batchId: string): Promise<ActionResult<number>> {
  const user = await importer();
  if (!user) return fail(DENIED);
  if (!isUuid(batchId)) return fail("Import not found.");
  try {
    const n = await startUndo(batchId, user);
    refresh(batchId);
    return ok(n);
  } catch (e) {
    return actionError(e);
  }
}

// ---------------------------------------------------------------------------
// Step 5: review
// ---------------------------------------------------------------------------

export async function skipRowsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  const rowId = str(fd, "rowId");
  if (!isUuid(batchId) || !isUuid(rowId)) return fail("Row not found.");
  const skip = str(fd, "skip") === "1";
  try {
    const n = await setRowsSkipped(batchId, [rowId], skip, user);
    if (!n) return fail(skip ? "This row cannot be skipped." : "This row cannot be brought back.");
  } catch (e) {
    return actionError(e);
  }
  refresh(batchId);
  return ok(undefined, skip ? "Row skipped" : "Row will be imported");
}

export async function resolveConflictAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  const rowId = str(fd, "rowId");
  const kind = str(fd, "kind");
  if (!isUuid(batchId) || !isUuid(rowId)) return fail("Row not found.");
  try {
    if (kind === "new") await resolveConflict(batchId, rowId, { kind: "new" }, user);
    else if (kind === "row") await resolveConflict(batchId, rowId, { kind: "row" }, user);
    else if (kind === "contact") {
      const contactId = str(fd, "contactId");
      if (!isUuid(contactId)) return fail("Choose a contact to merge into.");
      await resolveConflict(batchId, rowId, { kind: "contact", contactId }, user);
    } else return fail("Choose new or merge.");
  } catch (e) {
    return actionError(e);
  }
  refresh(batchId);
  return ok(undefined, kind === "new" ? "Will be a new contact" : "Will be merged");
}

export async function resolveAllConflictsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  if (!isUuid(batchId)) return fail("Import not found.");
  try {
    const n = await resolveAllConflictsAsNew(batchId, user);
    refresh(batchId);
    return ok(undefined, `${n.toLocaleString("en-IN")} conflict${n === 1 ? "" : "s"} will be new contacts, flagged for duplicate review.`);
  } catch (e) {
    return actionError(e);
  }
}

export async function discardBatchAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await importer();
  if (!user) return fail(DENIED);
  const batchId = str(fd, "batchId");
  if (!isUuid(batchId)) return fail("Import not found.");
  try {
    await discardBatch(batchId, user);
  } catch (e) {
    return actionError(e);
  }
  refresh();
  redirect("/import");
}
