"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, int, ok, str, type ActionResult } from "@/lib/action";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { countryCode } from "@/lib/contacts/rules";
import { currenciesWithRates, normalizeCurrency } from "@/lib/money/fx";
import { getSetting, getSettings, setSetting, type SettingKey } from "@/lib/settings";
import { DEFAULT_SELF_RATING_CONFIG, type IntegrationOptions } from "@/lib/webhooks/config";
import { validateFieldPaths, validateSelfRatingConfig } from "@/lib/webhooks/extract";
import { reprocessWebhookEvent, WebhookError } from "@/lib/webhooks/handlers";
import { isUuid } from "@/lib/utils";

const PAGE = "/settings/integrations";

function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function admin() {
  const user = await requireUser();
  return can(user, "settings.manage") ? user : null;
}

async function saveSetting<K extends SettingKey>(key: K, value: Parameters<typeof setSetting<K>>[1], userId: string) {
  const before = await getSetting(key);
  await setSetting(key, value, userId);
  await audit({ table: "settings", rowId: key, action: "update", field: key, oldValue: before, newValue: value, userId });
  revalidatePath(PAGE);
}

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `That is not valid JSON: ${(e as Error).message}` };
  }
}

/** Saves `integrations.fieldPaths`. Returns the cleaned JSON so the editor shows what was stored. */
export async function saveFieldPathsAction(_prev: ActionResult<string>, fd: FormData): Promise<ActionResult<string>> {
  const user = await admin();
  if (!user) return fail("Only an admin can change integrations.");
  const parsed = parseJson(str(fd, "json"));
  if (!parsed.ok) return fail(parsed.error);
  const v = validateFieldPaths(parsed.value);
  if (!v.ok) return fail(v.error);
  await saveSetting("integrations.fieldPaths", v.value, user.id);
  return ok(JSON.stringify(v.value, null, 2), "Field paths saved. New events use them; reprocess failed ones to apply them.");
}

/** Saves `integrations.selfRatings`; `reset` restores the defaults. */
export async function saveSelfRatingsAction(_prev: ActionResult<string>, fd: FormData): Promise<ActionResult<string>> {
  const user = await admin();
  if (!user) return fail("Only an admin can change integrations.");
  const doors = await getSetting("lists.firstDoors");
  let value: unknown;
  if (str(fd, "reset")) {
    value = DEFAULT_SELF_RATING_CONFIG;
  } else {
    const parsed = parseJson(str(fd, "json"));
    if (!parsed.ok) return fail(parsed.error);
    value = parsed.value;
  }
  const v = validateSelfRatingConfig(value, doors);
  if (!v.ok) return fail(v.error);
  await saveSetting("integrations.selfRatings", v.value, user.id);
  return ok(JSON.stringify(v.value, null, 2), str(fd, "reset") ? "Self-rating matchers reset to the defaults." : "Self-rating matchers saved.");
}

/** Saves `integrations.options`. */
export async function saveOptionsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await admin();
  if (!user) return fail("Only an admin can change integrations.");
  const s = await getSettings(["ladder.families", "currency"]);
  const errors: Record<string, string> = {};

  const country = countryCode(str(fd, "defaultCountry"));
  if (!country) errors.defaultCountry = "Use a two-letter country code, such as IN or AE.";
  const currency = normalizeCurrency(str(fd, "defaultCurrency"));
  if (!currenciesWithRates(s.currency).includes(currency)) {
    errors.defaultCurrency = "Pick a currency that has an INR rate in Settings > Currency.";
  }
  const family = str(fd, "tagmangoDefaultFamily");
  if (!family || !s["ladder.families"].some((f) => f.key === family)) errors.tagmangoDefaultFamily = "Pick a product family.";
  const hours = int(fd, "libromiWindowHours");
  if (hours === null || hours < 1 || hours > 168) errors.libromiWindowHours = "Use a number of hours from 1 to 168.";
  const timeZone = str(fd, "timeZone");
  if (!timeZone || !isTimeZone(timeZone)) errors.timeZone = "Pick a time zone, such as Asia/Kolkata.";
  if (Object.keys(errors).length) return fail("Check the highlighted fields.", errors);

  const value: IntegrationOptions = {
    defaultCountry: country!,
    defaultCurrency: currency,
    tagmangoDefaultFamily: family!,
    libromiWindowHours: hours!,
    timeZone: timeZone!,
  };
  await saveSetting("integrations.options", value, user.id);
  return ok(undefined, "Options saved.");
}

/**
 * Runs a failed or skipped webhook event again with the current settings. On success it opens the event, which
 * now shows its new state; a repeated failure stays on the form with the error.
 */
export async function reprocessEventAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await admin();
  if (!user) return fail("Only an admin can reprocess webhook events.");
  const id = str(fd, "id");
  if (!id || !isUuid(id)) return fail("That webhook event no longer exists.");
  let outcome;
  try {
    outcome = await reprocessWebhookEvent(id, user);
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    throw e;
  }
  revalidatePath(PAGE);
  if (!outcome.ok) return fail(`It failed again: ${outcome.error ?? "unknown error"}`);
  redirect(`${PAGE}?event=${id}&reprocessed=1#event`);
}
