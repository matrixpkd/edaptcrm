"use client";
import { Pin, PinOff, StickyNote } from "lucide-react";
import { addNoteAction, pinNoteAction } from "@/app/(app)/contacts/[id]/notes/actions";
import { ActionForm } from "@/components/contacts/action-form";
import { Checkbox, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

export type NoteView = { id: string; summary: string; when: string; author: string | null; pinned: boolean };

/** The pinned note, shown at the top of a contact (yellow, so nobody misses "Only call after 6 pm"). */
export function PinnedNoteBanner({ note, contactId, canPin }: { note: NoteView; contactId: string; canPin: boolean }) {
  return (
    <section aria-label="Pinned note" className="rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <Pin className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-line break-words text-sm font-medium">{note.summary}</p>
          <p className="mt-1 text-xs text-muted">
            {note.author ?? "Someone"} · {note.when}
          </p>
        </div>
        {canPin && (
          <ActionForm action={pinNoteAction} messageClassName="mt-1">
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="contactId" value={contactId} />
            <input type="hidden" name="pin" value="0" />
            <button
              type="submit"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface"
              aria-label="Unpin this note"
              title="Unpin"
            >
              <PinOff className="h-4 w-4" />
            </button>
          </ActionForm>
        )}
      </div>
    </section>
  );
}

/** Quick notes: one box to add a note (optionally pinned), and the latest notes with Pin. */
export function NotesCard({ contactId, notes, canAdd }: { contactId: string; notes: NoteView[]; canAdd: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="notes-title">
      <h2 id="notes-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <StickyNote className="h-4 w-4" aria-hidden /> Notes
      </h2>
      {canAdd && (
        <ActionForm action={addNoteAction} className="space-y-2" aria-label="Add a note">
          <input type="hidden" name="contactId" value={contactId} />
          <Textarea name="note" rows={2} required maxLength={4000} placeholder="Add a note for the team…" aria-label="Note" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox name="pin" label="Pin to the top" />
            <SubmitButton size="sm" pendingText="Saving…">
              Add note
            </SubmitButton>
          </div>
        </ActionForm>
      )}
      {notes.length > 0 ? (
        <ul className="mt-3 divide-y divide-border">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-3 whitespace-pre-line break-words text-sm">{n.summary}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {n.author ?? "Someone"} · {n.when}
                  {n.pinned && " · pinned"}
                </p>
              </div>
              {canAdd && !n.pinned && (
                <ActionForm action={pinNoteAction}>
                  <input type="hidden" name="noteId" value={n.id} />
                  <input type="hidden" name="contactId" value={contactId} />
                  <input type="hidden" name="pin" value="1" />
                  <button
                    type="submit"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-muted"
                    aria-label="Pin this note to the top"
                    title="Pin to the top"
                  >
                    <Pin className="h-4 w-4" />
                  </button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !canAdd && <p className="text-sm text-muted">No notes yet.</p>
      )}
    </section>
  );
}
