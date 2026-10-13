import { getCountries } from "libphonenumber-js/max";
import { countryName } from "./labels";

let cached: { value: string; label: string }[] | null = null;

/** Every country (ISO 3166-1 alpha-2) as select options, by name. Use from server components (the list is large). */
export function countryOptions(): { value: string; label: string }[] {
  cached ??= getCountries()
    .map((code) => ({ value: code, label: countryName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return cached;
}
