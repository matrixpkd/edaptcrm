import "server-only";
import { db, type Tx } from "@/db";
import { getSetting, type CurrencyConfig } from "@/lib/settings";
import { AdminError } from "./errors";
import { assertAdmin, inTx, saveSettingAudited, type AdminActor } from "./settings";
import { CURRENCY_RE, validateCurrency } from "./validate";

/**
 * Settings > Currency. INR is the base and always on; every other currency needs at least one monthly rate
 * (INR per 1 unit). Saved purchases and payments keep the rate they were entered at, so editing a rate never
 * changes past LTV.
 */

export type CurrencyEdit =
  | { op: "add"; currency: string; month: string; rate: number | null }
  | { op: "enable"; currency: string; on: boolean }
  | { op: "setRate"; currency: string; month: string; rate: number | null }
  | { op: "deleteRate"; currency: string; month: string };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Applies one edit to the currency config (pure); throws AdminError with a friendly reason. */
export function applyCurrencyEdit(cfg: CurrencyConfig, edit: CurrencyEdit): CurrencyConfig {
  const cur = edit.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) throw new AdminError("Use a three-letter currency code, such as USD", "currency");
  if (cur === "INR") throw new AdminError("INR is the base currency: it is always on and needs no rate", "currency");
  const next: CurrencyConfig = { base: "INR", enabled: [...cfg.enabled], rates: structuredClone(cfg.rates) };
  const needRate = (month: string, rate: number | null) => {
    if (!MONTH_RE.test(month)) throw new AdminError("Choose a month", "month");
    if (rate === null || !Number.isFinite(rate) || rate <= 0) throw new AdminError("Enter how many rupees one unit is worth, above 0", "rate");
  };
  switch (edit.op) {
    case "add":
      if (next.enabled.includes(cur)) throw new AdminError(`${cur} is already on`, "currency");
      needRate(edit.month, edit.rate);
      next.rates[cur] = { ...(next.rates[cur] ?? {}), [edit.month]: edit.rate! };
      next.enabled.push(cur);
      break;
    case "enable":
      if (edit.on) {
        if (!Object.keys(next.rates[cur] ?? {}).length) throw new AdminError(`Add a monthly rate for ${cur} first`);
        if (!next.enabled.includes(cur)) next.enabled.push(cur);
      } else {
        next.enabled = next.enabled.filter((c) => c !== cur);
      }
      break;
    case "setRate":
      needRate(edit.month, edit.rate);
      next.rates[cur] = { ...(next.rates[cur] ?? {}), [edit.month]: edit.rate! };
      break;
    case "deleteRate": {
      const table = { ...(next.rates[cur] ?? {}) };
      delete table[edit.month];
      if (!Object.keys(table).length && next.enabled.includes(cur)) {
        throw new AdminError(`That is ${cur}'s only rate. Switch ${cur} off first, or add another month.`);
      }
      if (Object.keys(table).length) next.rates[cur] = table;
      else delete next.rates[cur];
      break;
    }
  }
  return next;
}

/** Applies an edit and saves it (validated, audited). Returns warnings (e.g. rates for a switched-off currency). */
export async function editCurrency(edit: CurrencyEdit, actor: AdminActor, tx: Tx = db): Promise<{ warnings: string[] }> {
  assertAdmin(actor);
  return inTx(tx, async (t) => {
    const before = await getSetting("currency", t);
    const v = validateCurrency(applyCurrencyEdit(before, edit));
    if (!v.ok) throw new AdminError(v.error);
    // TagMango orders that name no currency are read in this one (Settings > Integrations): it must keep a rate
    const fallback = (await getSetting("integrations.options", t)).defaultCurrency?.toUpperCase();
    if (fallback && fallback !== "INR" && before.rates[fallback] && !v.value.rates[fallback]) {
      throw new AdminError(
        `TagMango orders without a currency are read as ${fallback}, so it needs at least one rate. Change that in Settings > Integrations first.`,
      );
    }
    await saveSettingAudited("currency", v.value, actor, t);
    return { warnings: v.warnings };
  });
}
