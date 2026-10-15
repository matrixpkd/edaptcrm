import Link from "next/link";
import { ListTodo, Plus, ShieldX } from "lucide-react";
import { NotesCard, PinnedNoteBanner, type NoteView } from "@/components/contacts/notes-card";
import { PrivacyCard } from "@/components/contacts/privacy-card";
import { TaskRowCard } from "@/components/tasks/task-row";
import type { Contact, Role } from "@/db/schema";
import { can, canEditContact } from "@/lib/auth/permissions";
import { getPinnedNote, recentNotes } from "@/lib/contacts/notes";
import { contactOpenTasks } from "@/lib/tasks/service";
import { rescheduleTargets, toTaskRowView } from "@/lib/tasks/view";
import { validTimeZone } from "@/lib/today/time";
import { formatDate, formatDateTime, formatINR } from "@/lib/utils";

/**
 * The contact page's beyond-the-spec cards (docs/CRM_GAP_ANALYSIS.md): the pinned note, open tasks with "Add task",
 * quick notes, and privacy (consent, erase). Loaded in parallel with the rest of the page.
 */

type Viewer = { id: string; role: Role; timezone?: string | null };

export async function loadContactExtras(contactId: string, viewer: Viewer) {
  const [pinned, notes, tasks] = await Promise.all([
    getPinnedNote(contactId),
    recentNotes(contactId, 3),
    contactOpenTasks(contactId, viewer),
  ]);
  return { pinned, notes, tasks };
}

type Extras = Awaited<ReturnType<typeof loadContactExtras>>;

function noteView(n: { id: string; summary: string | null; occurredAt: Date; pinnedAt: Date | null; authorName: string | null }, tz: string): NoteView {
  return { id: n.id, summary: n.summary ?? "", when: formatDateTime(n.occurredAt, tz), author: n.authorName, pinned: !!n.pinnedAt };
}

export function PinnedNote({ extras, contactId, viewer }: { extras: Extras; contactId: string; viewer: Viewer }) {
  if (!extras.pinned) return null;
  const tz = validTimeZone(viewer.timezone);
  return <PinnedNoteBanner note={noteView(extras.pinned, tz)} contactId={contactId} canPin={can(viewer, "interactions.log")} />;
}

export function ContactSideCards({ extras, contact, viewer }: { extras: Extras; contact: Contact; viewer: Viewer }) {
  const tz = validTimeZone(viewer.timezone);
  const now = new Date();
  const back = `/contacts/${contact.id}`;
  const canEdit = can(viewer, "contacts.edit") && canEditContact(viewer, contact);
  return (
    <>
      <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="contact-tasks-title">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="contact-tasks-title" className="flex items-center gap-2 text-sm font-semibold">
            <ListTodo className="h-4 w-4" aria-hidden /> Tasks
          </h2>
          <Link
            href={`/tasks/new?contact=${contact.id}&return=${encodeURIComponent(back)}`}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-muted"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add task
          </Link>
        </div>
        {extras.tasks.length ? (
          <ul className="space-y-2">
            {extras.tasks.map((t) => (
              <TaskRowCard
                key={t.id}
                task={toTaskRowView(t, viewer, now, tz, { showAssignee: t.userId !== viewer.id })}
                reschedule={rescheduleTargets(now, tz)}
                returnTo={back}
                compact
                hideContact
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No open tasks or follow-ups. Add one so it comes back on Today.</p>
        )}
      </section>
      <NotesCard contactId={contact.id} notes={extras.notes.map((n) => noteView(n, tz))} canAdd={can(viewer, "interactions.log")} />
      <PrivacyCard
        contactId={contact.id}
        name={contact.name}
        consent={contact.consent}
        consentSince={contact.consentAt ? formatDate(contact.consentAt, tz) : null}
        canConsent={canEdit}
        canErase={can(viewer, "contacts.erase")}
      />
    </>
  );
}

/** What an erased contact's page shows: no personal data, the money kept for the accounts. */
export function ErasedContact({ contact, viewer }: { contact: Contact; viewer: Viewer }) {
  const tz = validTimeZone(viewer.timezone);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link href="/contacts" className="text-sm text-muted hover:underline">
        ← Contacts
      </Link>
      <div className="rounded-2xl border border-border bg-surface p-6 text-center">
        <ShieldX className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden />
        <h1 className="text-xl font-semibold">Erased contact</h1>
        <p className="mt-1 text-sm text-muted">
          This person&apos;s personal data was erased on request{contact.erasedAt ? ` on ${formatDate(contact.erasedAt, tz)}` : ""}. Their
          purchases and payments are kept, anonymised, for the accounts.
        </p>
        <p className="tabular mt-4 text-2xl font-semibold">{formatINR(contact.ltvInr)}</p>
        <p className="text-xs text-muted">
          LTV kept · {contact.purchaseCount} purchase{contact.purchaseCount === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}
