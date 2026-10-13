/**
 * Plain-language lines for a purchase's audit trail (audit_log rows written by the money services).
 * Pure: unit tested in tests/unit/payments-rules.test.ts.
 */
import type { PaymentKind } from "@/db/schema";
import { PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, formatAmount } from "@/components/contacts/labels";

export type AuditInput = {
  tableName: string;
  rowId: string | null;
  action: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
};

export type AuditContext = {
  currency: string;
  hasInstalments: boolean;
  /** payment id -> its number and kind */
  payments: Map<string, { seq: number; kind: PaymentKind }>;
  /** user id -> name, for credit changes */
  names: Map<string, string>;
};

export type AuditText = { title: string; detail?: string } | null;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function money(v: unknown, currency: unknown, fallback: string): string | null {
  const n = num(v);
  if (n == null || !Number.isFinite(n)) return null;
  return formatAmount(n, typeof currency === "string" && currency ? currency : fallback);
}

function join(parts: (string | null | undefined | false)[]): string | undefined {
  const out = parts.filter(Boolean).join(" · ");
  return out || undefined;
}

function paymentName(rowId: string | null, ctx: AuditContext): string {
  const p = rowId ? ctx.payments.get(rowId) : undefined;
  if (!p) return "Payment";
  if (p.kind === "refund") return "Refund";
  return ctx.hasInstalments ? `Instalment ${p.seq}` : p.seq > 1 ? `Payment ${p.seq}` : "Payment";
}

/** One readable line for an audit row, or null for rows folded into another line (e.g. "assisted"). */
export function describeAudit(line: AuditInput, ctx: AuditContext): AuditText {
  const { tableName, action, field, oldValue, newValue } = line;

  if (field === "reference" && newValue == null) {
    return { title: "Reference released", detail: join([text(oldValue), "freed by the cancellation so it can be recorded again"]) };
  }

  if (tableName === "purchases") {
    if (action === "insert") {
      const v = isObj(newValue) ? newValue : {};
      const mode = text(v.mode);
      const instalments = num(v.instalments) ?? 0;
      const paidNow = num(v.paidNow) ?? 0;
      return {
        title: "Purchase recorded",
        detail: join([
          money(v.amount, v.currency, ctx.currency),
          mode ? (PAYMENT_MODE_LABELS[mode as keyof typeof PAYMENT_MODE_LABELS] ?? mode) : null,
          text(v.reference) ? `ref ${text(v.reference)}` : null,
          instalments ? `${instalments} instalments` : null,
          paidNow ? `${money(paidNow, v.currency, ctx.currency)} paid now${v.verified === true ? ", verified" : v.verified === false ? ", unverified" : ""}` : "nothing paid yet",
        ]),
      };
    }
    if (field === "creditedUserId") {
      const from = typeof oldValue === "string" ? (ctx.names.get(oldValue) ?? "a former user") : "self-serve";
      const to = typeof newValue === "string" ? (ctx.names.get(newValue) ?? "a former user") : "self-serve";
      return { title: "Sales credit changed", detail: `${capital(from)} → ${to}` };
    }
    if (field === "assisted") return null;
    if (field === "status") {
      const v = isObj(newValue) ? newValue : { status: newValue };
      if (v.status === "cancelled") return { title: "Purchase cancelled", detail: text(v.reason) ?? undefined };
      return { title: `Status changed to ${String(v.status)}` };
    }
    if (field === "schedule") {
      const before = Array.isArray(oldValue) ? (oldValue as Obj[]) : [];
      const after = Array.isArray(newValue) ? (newValue as Obj[]) : [];
      const changes = before.map((b) => {
        const a = after.find((x) => x.id === b.id);
        const amount = num(a?.amount) ?? 0;
        return `#${num(b.seq) ?? "?"} ${money(b.amount, null, ctx.currency)} → ${amount ? money(amount, null, ctx.currency) : "removed"}`;
      });
      return { title: "Schedule adjusted for money paid ahead", detail: join(changes) };
    }
    return { title: `Purchase ${action}${field ? ` · ${field}` : ""}` };
  }

  if (tableName === "payments") {
    const name = paymentName(line.rowId, ctx);
    if (action === "insert" && field === "refund") {
      const v = isObj(newValue) ? newValue : {};
      return { title: "Refund recorded", detail: join([money(v.amount, v.currency, ctx.currency), text(v.reason), text(v.reference) ? `ref ${text(v.reference)}` : null]) };
    }
    if (action === "insert") {
      const v = isObj(newValue) ? newValue : {};
      const status = text(v.status);
      return {
        title: "Part payment recorded",
        detail: join([
          money(v.amount, v.currency, ctx.currency),
          text(v.mode) ? (PAYMENT_MODE_LABELS[text(v.mode) as keyof typeof PAYMENT_MODE_LABELS] ?? text(v.mode)) : null,
          text(v.reference) ? `ref ${text(v.reference)}` : null,
          status ? (PAYMENT_STATUS_LABELS[status as keyof typeof PAYMENT_STATUS_LABELS] ?? status).toLowerCase() : null,
        ]),
      };
    }
    if (action === "verify") {
      if (isObj(newValue)) {
        return { title: `${name} paid and verified`, detail: join([money(newValue.amount, null, ctx.currency), text(newValue.reference) ? `ref ${text(newValue.reference)}` : null]) };
      }
      return { title: `${name} verified`, detail: oldValue === "rejected" ? "after being rejected" : undefined };
    }
    if (field === "status") {
      const v = isObj(newValue) ? newValue : { status: newValue };
      if (v.status === "rejected") return { title: `${name} rejected`, detail: text(v.reason) ?? undefined };
      if (v.status === "unverified") {
        return { title: `${name} paid, waiting for verification`, detail: join([money(v.amount, null, ctx.currency), text(v.reference) ? `ref ${text(v.reference)}` : null]) };
      }
      return { title: `${name} ${String(v.status)}` };
    }
    return { title: `${name} ${action}${field ? ` · ${field}` : ""}` };
  }

  return { title: `${tableName} ${action}` };
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
