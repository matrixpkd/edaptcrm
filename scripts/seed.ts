/**
 * Seeds the first admin (from ADMIN_* env vars) and the starter product catalogue.
 * Safe to run more than once. `npm run db:seed -- --demo` also loads demo data.
 */
import "./env";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";

const STARTER_PRODUCTS = [
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

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "umer@edapt.in").toLowerCase();
  const [existing] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);
  if (!existing) {
    await db.insert(users).values({
      name: process.env.ADMIN_NAME ?? "Umer Abdussalam",
      email,
      passwordHash: await hashPassword(process.env.ADMIN_PASSWORD ?? "change-me-now"),
      role: "admin",
      team: "kerala",
    });
    console.log(`Created admin ${email}`);
  } else {
    console.log(`Admin ${email} already exists`);
  }

  const [{ n }] = await db.select({ n: count() }).from(products);
  if (n === 0) {
    await db.insert(products).values(STARTER_PRODUCTS.map((p) => ({ ...p, active: p.active ?? true })));
    console.log(`Created ${STARTER_PRODUCTS.length} starter products (edit prices in Settings → Products)`);
  }

  if (process.argv.includes("--demo")) {
    const { seedDemo } = await import("./seed-demo");
    await seedDemo();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
