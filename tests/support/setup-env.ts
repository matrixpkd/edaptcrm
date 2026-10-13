import { config } from "dotenv";
config({ path: ".env.test", override: true });
// Parallel workers can point at their own database: TEST_DATABASE_URL=postgres://.../edapt_test_x npm test
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
