"use client";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/action";

type Action = (prev: ActionResult<string>, fd: FormData) => Promise<ActionResult<string>>;

/**
 * A JSON setting editor. The text is controlled, so a rejected save keeps what was typed; a successful save
 * shows the cleaned value the server stored.
 */
export function JsonEditor({
  action,
  initial,
  label,
  hint,
  rows = 12,
  allowReset = false,
  placeholder,
}: {
  action: Action;
  initial: string;
  label: string;
  hint?: React.ReactNode;
  rows?: number;
  /** show "Restore defaults" (submits restoreDefaults=1) */
  allowReset?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const [syntax, setSyntax] = useState<string | null>(null);
  const [state, formAction] = useActionState(action, null);
  const seen = useRef<ActionResult<string>>(null);

  useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok && typeof state.data === "string") setText(state.data);
  }, [state]);

  function check(value: string) {
    if (!value.trim()) return setSyntax(null);
    try {
      JSON.parse(value);
      setSyntax(null);
    } catch (e) {
      setSyntax((e as Error).message);
    }
  }

  function format() {
    try {
      setText(JSON.stringify(JSON.parse(text || "{}"), null, 2));
      setSyntax(null);
    } catch (e) {
      setSyntax((e as Error).message);
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      <textarea
        id={id}
        name="json"
        rows={rows}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-invalid={syntax ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          // once a syntax hint shows, keep it current while typing (clearing it on blur would move the Save button
          // under the pointer)
          if (syntax) check(e.target.value);
        }}
        onBlur={(e) => check(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-base leading-relaxed sm:text-xs text-foreground focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10"
      />
      {syntax && (
        <p className="text-xs text-danger" role="alert">
          Not valid JSON yet: {syntax}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
        <Button type="button" variant="ghost" onClick={format}>
          Tidy JSON
        </Button>
        {allowReset && (
          <Button
            type="submit"
            variant="ghost"
            // never name a form control "reset": it hides form.reset(), which React calls after every action
            name="restoreDefaults"
            value="1"
            onClick={(e) => {
              if (!window.confirm("Replace the matchers with the defaults?")) e.preventDefault();
            }}
          >
            Restore defaults
          </Button>
        )}
      </div>
      <FormMessage state={state} />
    </form>
  );
}
