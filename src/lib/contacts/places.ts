import "server-only";
/**
 * City and state suggestions for the profile's "search dropdown" (spec "Customer profile": City, state, country —
 * Search dropdown). Free text stays allowed (a small town nobody typed yet); the suggestions keep spellings
 * consistent, which the Fit location class (Kerala cities and Indian metros, Kerala state names) depends on.
 */
import { sql } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { getSetting } from "@/lib/settings";
import type { LocationConfig } from "@/lib/settings/defaults";
import { placeSuggestionList } from "./rules";

/** Most used cities and states among live contacts (one aggregate per column). */
const TOP_PLACES = 300;

export type PlaceSuggestions = { cities: string[]; states: string[] };

export async function placeSuggestions(tx: Tx = db): Promise<PlaceSuggestions> {
  const [locations, rows] = await Promise.all([
    getSetting("locations", tx),
    queryRows<{ kind: string; v: string }>(sql`
      (select 'city' as kind, trim(city) as v from contacts
        where merged_into_id is null and city is not null and trim(city) <> ''
        group by trim(city) order by count(*) desc limit ${TOP_PLACES})
      union all
      (select 'state' as kind, trim(state) as v from contacts
        where merged_into_id is null and state is not null and trim(state) <> ''
        group by trim(state) order by count(*) desc limit ${TOP_PLACES})
    `, tx),
  ]);
  const used = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.v);
  return {
    cities: placeSuggestionList(builtInCities(locations), used("city")),
    states: placeSuggestionList(["Kerala", ...STATES], used("state")),
  };
}

/**
 * Cities every list starts with, no query needed (Quick Add): the Kerala cities and Indian metros from settings
 * `locations` (what the Fit location class looks for) and the GCC cities.
 */
export function builtInCities(locations: LocationConfig): string[] {
  return [...locations.keralaCities, ...locations.indianMetros, ...GCC_CITIES];
}

const GCC_CITIES = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Al Ain", "Ras Al Khaimah", "Fujairah", "Doha", "Riyadh", "Jeddah", "Dammam", "Muscat", "Kuwait City", "Manama"];

/** Indian states and union territories, and the GCC regions Edapt sells in. */
const STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Delhi",
  "Puducherry",
  "Lakshadweep",
  "Jammu and Kashmir",
  "Ladakh",
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Ras Al Khaimah",
  "Fujairah",
  "Umm Al Quwain",
];
