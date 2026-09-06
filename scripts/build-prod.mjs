/**
 * Production Vite build with VITE_OTP_ENABLED sourced only from Vercel Production.
 * Usage: node scripts/build-prod.mjs   (via npm run build:prod)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProdBuildEnv,
  ENVIRONMENT_KEY,
  loadEffectiveProductionEnv,
  PROD_SUPABASE_PROJECT_REF,
  SUPABASE_URL_KEY,
} from "./lib/prodBuildEnv.mjs";
import {
  OTP_KEY,
  banner,
  fetchVercelProductionOtpEnabled,
} from "./lib/vercelOtpEnabled.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envProductionPath = path.join(root, ".env.production");

// Guard against a drifting local copy — Vercel is the only source.
if (fs.existsSync(envProductionPath)) {
  const text = fs.readFileSync(envProductionPath, "utf8");
  if (new RegExp(`^${OTP_KEY}=`, "m").test(text)) {
    banner("PROD BUILD BLOCKED — local VITE_OTP_ENABLED must not exist", [
      `${envProductionPath} still defines ${OTP_KEY}.`,
      "Remove that line. OTP is fetched from Vercel Production at build time.",
      "Other keys in .env.production (URL, Sentry, etc.) may remain.",
    ]);
    process.exit(1);
  }
}

const { value } = await fetchVercelProductionOtpEnabled();
console.log(`[build:prod] ${OTP_KEY}=${JSON.stringify(value)} (from Vercel Production)`);

const effective = loadEffectiveProductionEnv(process.env, envProductionPath);
effective[OTP_KEY] = value;
assertProdBuildEnv(effective);

const supabaseUrl = String(effective[SUPABASE_URL_KEY] ?? "").trim().replace(/\/$/, "");
console.log(
  `[build:prod] ${SUPABASE_URL_KEY}=${JSON.stringify(supabaseUrl)} (PROD ${PROD_SUPABASE_PROJECT_REF})`,
);
console.log(
  `[build:prod] ${ENVIRONMENT_KEY}=${JSON.stringify(effective[ENVIRONMENT_KEY])}`,
);

const env = { ...process.env, [OTP_KEY]: value };
// Ensure Vite does not inherit a stale shell override that disagrees — we just set it.
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build", "--mode", "production"],
  { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) {
  banner("PROD BUILD FAILED — could not start vite", [result.error.message]);
  process.exit(1);
}
process.exit(result.status ?? 1);
