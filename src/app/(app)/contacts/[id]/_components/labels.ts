import { labelFor, type ListItem, type ProductFamily } from "@/lib/settings";

/** Settings-list label lookups for the contact page (stored values are keys). */
export type Labels = {
  channel: (k: string | null | undefined) => string;
  campaign: (k: string | null | undefined) => string;
  door: (k: string | null | undefined) => string;
  language: (k: string | null | undefined) => string;
  ageBand: (k: string | null | undefined) => string;
  industry: (k: string | null | undefined) => string;
  outcome: (k: string | null | undefined) => string;
  lostReason: (k: string | null | undefined) => string;
  tag: (k: string | null | undefined) => string;
  family: (k: string | null | undefined) => string;
};

export function makeLabels(s: {
  channels: ListItem[];
  campaigns: ListItem[];
  doors: ListItem[];
  languages: ListItem[];
  ageBands: ListItem[];
  industries: ListItem[];
  outcomes: ListItem[];
  lostReasons: ListItem[];
  tags: ListItem[];
  families: ProductFamily[];
}): Labels {
  return {
    channel: (k) => labelFor(s.channels, k),
    campaign: (k) => labelFor(s.campaigns, k),
    door: (k) => labelFor(s.doors, k),
    language: (k) => labelFor(s.languages, k),
    ageBand: (k) => labelFor(s.ageBands, k),
    industry: (k) => labelFor(s.industries, k),
    outcome: (k) => labelFor(s.outcomes, k),
    lostReason: (k) => labelFor(s.lostReasons, k),
    tag: (k) => labelFor(s.tags, k),
    family: (k) => (k ? (s.families.find((f) => f.key === k)?.label ?? k) : ""),
  };
}
