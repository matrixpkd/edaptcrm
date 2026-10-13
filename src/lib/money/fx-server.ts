import "server-only";
import { db, type Tx } from "@/db";
import { getSetting } from "@/lib/settings";
import { rateFromTable } from "./fx";

/**
 * INR per 1 unit of `currency` for a payment made at `at`, from Settings > Currency (see rateFromTable).
 * Throws UnknownCurrencyError when the currency has no rate.
 */
export async function getFxRate(currency: string, at: Date, tx: Tx = db): Promise<number> {
  const cfg = await getSetting("currency", tx);
  return rateFromTable(cfg.rates, currency, at);
}
