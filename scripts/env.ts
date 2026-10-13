import { config } from "dotenv";
// Scripts read .env.local (dev) unless DATABASE_URL is already set (CI / production).
if (!process.env.DATABASE_URL) config({ path: ".env.local" });
