"use client";
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/contacts/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MessageTemplate } from "@/lib/settings/defaults";
import { fillTemplate, TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX, unknownPlaceholders } from "@/lib/templates/whatsapp";
import { saveTemplatesAction } from "./actions";

const SAMPLE = { name: "Priya Nair", offer: "Applied AI Mastery", owner: "Asha" };

/** Add, edit, reorder, switch off and delete WhatsApp templates, with a live preview for a sample contact. */
export function TemplatesEditor({ initial }: { initial: MessageTemplate[] }) {
  const [items, setItems] = useState<MessageTemplate[]>(initial);
  const update = (i: number, patch: Partial<MessageTemplate>) => setItems((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const move = (i: number, d: -1 | 1) =>
    setItems((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  return (
    <ActionForm action={saveTemplatesAction} className="space-y-4" aria-label="Message templates">
      <input type="hidden" name="json" value={JSON.stringify(items)} />
      {items.length === 0 && <p className="text-sm text-muted">No templates. WhatsApp then opens an empty chat.</p>}
      <ol className="space-y-4">
        {items.map((t, i) => {
          const unknown = unknownPlaceholders(t.body);
          return (
            <li key={i} className="rounded-xl border border-border p-3" aria-label={`Template ${i + 1}`}>
              <div className="grid gap-3">
                <Field label="Name" htmlFor={`tpl-name-${i}`}>
                  <Input id={`tpl-name-${i}`} value={t.name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => update(i, { name: e.target.value })} />
                </Field>
                <Field
                  label="Message"
                  htmlFor={`tpl-body-${i}`}
                  error={unknown.length ? `Unknown placeholder: ${unknown.map((u) => `{${u}}`).join(", ")}` : null}
                >
                  <Textarea id={`tpl-body-${i}`} rows={3} value={t.body} maxLength={TEMPLATE_BODY_MAX} onChange={(e) => update(i, { body: e.target.value })} />
                </Field>
                <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">Preview · </span>
                  {fillTemplate(t.body, SAMPLE)}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox checked={t.active !== false} onChange={(e) => update(i, { active: e.target.checked ? undefined : false })} label="In use" />
                  <span className="flex-1" />
                  <Button size="icon" variant="ghost" aria-label={`Move template ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Move template ${i + 1} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                    aria-label={`Delete template ${i + 1}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden /> Delete
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setItems((list) => [...list, { id: "", name: "", body: "Hi {first_name}, " }])}>
          <Plus className="h-4 w-4" aria-hidden /> Add template
        </Button>
        <SubmitButton pendingText="Saving…">Save templates</SubmitButton>
      </div>
    </ActionForm>
  );
}
