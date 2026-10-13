// The e2e web server (playwright.config.ts webServer): a production build in NEXT_DIST_DIR (.next-e2e), then
// `next start` on E2E_PORT. E2E_SKIP_BUILD=1 reuses the last build. `next build` adds "<distDir>/types/**/*.ts" to
// tsconfig.json; that entry is taken out again so a test run leaves the tree as it found it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const distDir = process.env.NEXT_DIST_DIR || ".next-e2e";
const port = process.env.E2E_PORT || "3403";
const nextBin = path.join(root, "node_modules/next/dist/bin/next");
const env = { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" };

function untouchTsconfig(before) {
  const file = path.join(root, "tsconfig.json");
  const after = fs.readFileSync(file, "utf8");
  if (after === before) return;
  const entry = `${distDir}/types/**/*.ts`;
  const a = JSON.parse(before);
  const b = JSON.parse(after);
  const strip = (cfg) => ({ ...cfg, include: (cfg.include ?? []).filter((i) => i !== entry) });
  const same = (x, y) => JSON.stringify({ ...x, include: [...x.include].sort() }) === JSON.stringify({ ...y, include: [...y.include].sort() });
  // only Next's own edit (the types entry, maybe a reordered include): put the file back exactly as it was
  if (same(strip(a), strip(b))) fs.writeFileSync(file, before);
  else fs.writeFileSync(file, JSON.stringify(strip(b), null, 2) + "\n");
}

if (process.env.E2E_SKIP_BUILD !== "1" || !fs.existsSync(path.join(root, distDir, "BUILD_ID"))) {
  const before = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
  const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: root, env, stdio: "inherit" });
  untouchTsconfig(before);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, [nextBin, "start", "-p", port], { cwd: root, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
