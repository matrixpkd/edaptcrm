/**
 * Seeds the first admin (from ADMIN_* env vars) and the starter product catalogue.
 * Safe to run more than once. `npm run db:seed -- --demo` also loads demo data.
 */
import "./env";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { STARTER_PRODUCTS } from "./starter-products";

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "umer@edapt.in").toLowerCase();
  const [existing] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);
  if (!existing) {
    // the documented dev default must never become a real admin password: outside a local database, insist on
    // a real ADMIN_PASSWORD (docs/SECURITY.md)
    const password = process.env.ADMIN_PASSWORD ?? "change-me-now";
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
    if (!local && (password === "change-me-now" || password.length < 10)) {
      throw new Error("Set ADMIN_PASSWORD (at least 10 characters, not the example value) to seed an admin outside a local database.");
    }
    await db.insert(users).values({
      name: process.env.ADMIN_NAME ?? "Umer Abdussalam",
      email,
      passwordHash: await hashPassword(password),
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
