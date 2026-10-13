/** The starter product catalogue `npm run db:seed` creates (prices are placeholders: edit them in Settings > Products). */
export const STARTER_PRODUCTS: {
  name: string;
  family: string;
  rung: number | null;
  listPrice: number;
  currency: string;
  active?: boolean;
}[] = [
  { name: "Entry AI Workshop", family: "workshop", rung: 1, listPrice: 699, currency: "INR" },
  { name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999, currency: "INR" },
  { name: "AI Agents for Business", family: "workshop", rung: 1, listPrice: 1999, currency: "INR" },
  { name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 24999, currency: "INR" },
  { name: "The AI Office membership", family: "ai_office", rung: 3, listPrice: 999, currency: "USD" },
  { name: "Premium program", family: "premium", rung: 4, listPrice: 150000, currency: "INR" },
  { name: "Consulting engagement", family: "consulting", rung: 4, listPrice: 50000, currency: "INR" },
  { name: "School AI program", family: "b2b_program", rung: null, listPrice: 100000, currency: "INR" },
  { name: "Constituency AI literacy program", family: "constituency_program", rung: null, listPrice: 200000, currency: "INR" },
  { name: "International delegation", family: "delegation", rung: null, listPrice: 150000, currency: "INR", active: false },
];
