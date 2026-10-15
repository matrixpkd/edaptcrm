"use client";
import { useState } from "react";
import { ActionForm } from "@/components/contacts/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";
import { ContactPicker } from "./contact-picker";

export type DueChip = { key: string; label: string; date: string };

type Props = {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  /** "task": everything editable; "follow_up": reschedule only (its text is the logged touch) */
  kind?: "task" | "follow_up";
  taskId?: string;
  initial?: {
    title?: string;
    notes?: string | null;
    dueDate?: string;
    dueTime?: string;
    assigneeId?: string;
  };
  /** a contact fixed by the page (contact page "Add task") */
  fixedContact?: { id: string; name: string } | null;
  /** the contact already on the task (editable through the picker) */
  pickerContact?: { id: string; name: string } | null;
  /** Today, Tomorrow, In 3 days, Next week as local dates */
  chips: DueChip[];
  /** default time when the date is today (the next whole hour once 10:00 has passed) */
  todayTime?: string;
  minDate: string;
  assignees: { value: string; label: string }[] | null;
  meId: string;
  returnTo?: string | null;
  submitLabel: string;
};

/** The task form (new and edit). Phone first: big title, date chips, a time, then the optional fields. */
export function TaskForm({
  action,
  kind = "task",
  taskId,
  initial = {},
  fixedContact,
  pickerContact,
  chips,
  minDate,
  assignees,
  meId,
  returnTo,
  submitLabel,
  todayTime = "10:00",
}: Props) {
  const [date, setDate] = useState(initial.dueDate ?? chips[0]?.date ?? minDate);
  const [time, setTime] = useState(initial.dueTime ?? (date === minDate ? todayTime : "10:00"));
  // until the person types a time, it follows the date: later today, or 10:00 on another day
  const [timeTouched, setTimeTouched] = useState(!!initial.dueTime);
  const pickDate = (d: string) => {
    setDate(d);
    if (!timeTouched) setTime(d === minDate ? todayTime : "10:00");
  };
  const editsText = kind === "task";
  return (
    <ActionForm action={action} className="space-y-5" aria-label={submitLabel}>
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      <input type="hidden" name="kind" value={kind} />
      {returnTo && <input type="hidden" name="return" value={returnTo} />}
      {fixedContact && <input type="hidden" name="contactId" value={fixedContact.id} />}

      {editsText ? (
        <Field label="What needs doing" htmlFor="task-title" required>
          <Input
            id="task-title"
            name="title"
            required
            maxLength={200}
            defaultValue={initial.title}
            placeholder="e.g. Send the AI Office brochure"
            className="h-12 text-base"
            autoFocus={!initial.title}
          />
        </Field>
      ) : (
        <div className="rounded-lg bg-surface-muted px-3 py-2 text-sm">
          <p className="font-medium">{initial.title}</p>
          <p className="mt-0.5 text-xs text-muted">A follow-up from a logged touch: you can move it to another time.</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Due</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick dates">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={date === c.date}
              onClick={() => pickDate(c.date)}
              className={cn(
                "rounded-full border px-3.5 py-2 text-sm font-medium",
                date === c.date ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="task-date">
            <Input id="task-date" type="date" name="dueDate" required min={minDate} value={date} onChange={(e) => pickDate(e.target.value)} />
          </Field>
          <Field label="Time" htmlFor="task-time" hint="Your time zone">
            <Input
              id="task-time"
              type="time"
              name="dueTime"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setTimeTouched(true);
              }}
            />
          </Field>
        </div>
      </fieldset>

      {editsText && (
        <>
          {assignees ? (
            <Field label="For" htmlFor="task-assignee">
              <Select id="task-assignee" name="assigneeId" defaultValue={initial.assigneeId ?? meId}>
                {assignees.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.value === meId ? `${a.label} — me` : a.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <input type="hidden" name="assigneeId" value={initial.assigneeId ?? meId} />
          )}
          {fixedContact ? (
            <p className="text-sm">
              <span className="text-muted">Contact: </span>
              <span className="font-medium">{fixedContact.name}</span>
            </p>
          ) : (
            <Field label="Contact" htmlFor="task-contact" hint="Optional. Linked tasks show on the contact page and open it from Today.">
              <ContactPicker name="contactId" initial={pickerContact} inputId="task-contact" />
            </Field>
          )}
          <Field label="Notes" htmlFor="task-notes">
            <Textarea id="task-notes" name="notes" rows={3} maxLength={2000} defaultValue={initial.notes ?? ""} />
          </Field>
        </>
      )}
      {!editsText && pickerContact && <input type="hidden" name="contactId" value={pickerContact.id} />}

      <SubmitButton size="lg" className="w-full sm:w-auto" pendingText="Saving…">
        {submitLabel}
      </SubmitButton>
    </ActionForm>
  );
}
