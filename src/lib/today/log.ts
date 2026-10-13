import "server-only";
import { db, type Database, type Tx } from "@/db";
import type { Contact } from "@/db/schema";
import { logInteraction, type LogInteractionInput } from "@/lib/contacts/interactions";
import type { Actor } from "@/lib/contacts/internal";
import { setManualStage } from "@/lib/contacts/lifecycle";

/**
 * The Log interaction sheet's save: logs the interaction and, when asked, marks the contact Lost with a reason
 * (spec "Lifecycle stages"), all in one transaction — if the stage change is refused, nothing is logged.
 * Permission checks live in the services (support may log but never set a stage).
 */
export async function logFromSheet(
  contactId: string,
  input: LogInteractionInput,
  lost: { markLost: boolean; lostReason?: string | null },
  actor: Actor,
  tx: Tx = db,
): Promise<{ interactionId: string; contact: Contact | null }> {
  return (tx as Database).transaction(async (t) => {
    const interactionId = await logInteraction(contactId, input, actor, t);
    const contact = lost.markLost
      ? await setManualStage(contactId, "lost", { lostReason: lost.lostReason ?? null }, actor, t)
      : null;
    return { interactionId, contact };
  });
}
