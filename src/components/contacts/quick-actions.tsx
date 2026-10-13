"use client";
import Link from "next/link";
import { MessageCircle, NotebookPen, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

const PENDING_CALL_KEY = "edapt:pendingCall";

type Props = {
  contact: { id: string; name: string; phoneE164: string };
  /** "row" = compact icons for lists; "full" = labelled buttons for the contact page */
  variant?: "row" | "full";
  className?: string;
  /** optional WhatsApp greeting */
  whatsappText?: string;
};

function digits(e164: string) {
  return e164.replace(/\D/g, "");
}

/** Remembers that a call was started so the Log interaction screen opens when the user comes back. */
export function rememberCall(contactId: string) {
  try {
    // `from`: the page the call started on (e.g. Today), so saving the log goes back there
    const from = window.location.pathname + window.location.search;
    sessionStorage.setItem(PENDING_CALL_KEY, JSON.stringify({ contactId, at: Date.now(), from }));
  } catch {
    /* storage unavailable: logging is still one tap away */
  }
}

export function readPendingCall(): { contactId: string; at: number; from?: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CALL_KEY);
    return raw ? (JSON.parse(raw) as { contactId: string; at: number; from?: string }) : null;
  } catch {
    return null;
  }
}

export function clearPendingCall() {
  try {
    sessionStorage.removeItem(PENDING_CALL_KEY);
  } catch {
    /* ignore */
  }
}

/** One-tap Call, WhatsApp and Log buttons. Call opens the phone dialler. */
export function ContactQuickActions({ contact, variant = "row", className, whatsappText }: Props) {
  const wa = `https://wa.me/${digits(contact.phoneE164)}${whatsappText ? `?text=${encodeURIComponent(whatsappText)}` : ""}`;
  if (variant === "full") {
    return (
      <div className={cn("grid grid-cols-3 gap-2", className)}>
        <a
          href={`tel:${contact.phoneE164}`}
          onClick={() => rememberCall(contact.id)}
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-white active:scale-[0.98]"
        >
          <Phone className="h-4 w-4" /> Call
        </a>
        <a
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-[#1f9d55] text-sm font-semibold text-white active:scale-[0.98]"
        >
          <MessageCircle className="h-4 w-4" /> WhatsApp
        </a>
        <Link
          href={`/contacts/${contact.id}/log`}
          className="flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold active:scale-[0.98]"
        >
          <NotebookPen className="h-4 w-4" /> Log
        </Link>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <a
        href={`tel:${contact.phoneE164}`}
        onClick={() => rememberCall(contact.id)}
        aria-label={`Call ${contact.name}`}
        title="Call"
        className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white active:scale-95"
      >
        <Phone className="h-4 w-4" />
      </a>
      <a
        href={wa}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`WhatsApp ${contact.name}`}
        title="WhatsApp"
        className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1f9d55] text-white active:scale-95"
      >
        <MessageCircle className="h-4 w-4" />
      </a>
    </div>
  );
}
