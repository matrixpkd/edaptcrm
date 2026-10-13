/**
 * Source presets (step 1): the defaults each kind of file starts with. Every value is editable in step 2.
 * Pure.
 */
import type { ImportDefaults, ImportSource } from "./types";

/** The tag the spec gives the delegation customer list. */
export const DELEGATION_TAG = "Legacy: Delegation";

export function presetDefaults(source: ImportSource): ImportDefaults {
  const base: ImportDefaults = {
    source,
    firstDoor: null,
    campaign: null,
    tags: [],
    tagWithCampaign: false,
    defaultCountry: "IN",
    ownerFallback: "pool",
    ownerFromFile: false,
    recordsDate: null,
    dayFirst: true,
    currency: "INR",
    paymentMode: "other",
    verified: true,
    productFamily: null,
    productMap: {},
  };
  switch (source) {
    case "tagmango":
      // every row is a real payment
      return { ...base, paymentMode: "tagmango", verified: true };
    case "zoho":
      // Zoho holds today's salesperson assignments: its owners carry over, even onto contacts already imported
      return { ...base, ownerFromFile: true };
    case "delegation":
      return { ...base, firstDoor: "delegation", tags: [DELEGATION_TAG], productFamily: "delegation" };
    case "program_sheet":
      return { ...base, firstDoor: "mla_program", tagWithCampaign: true, productFamily: "constituency_program" };
    case "other":
    default:
      return base;
  }
}

/** TagMango rows are payments by definition: they are always verified and always carry the TagMango mode. */
export function lockedForSource(source: ImportSource): { verified?: boolean; paymentMode?: "tagmango" } {
  return source === "tagmango" ? { verified: true, paymentMode: "tagmango" } : {};
}
