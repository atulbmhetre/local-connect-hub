/**
 * Production build env guards — same loud-fail pattern as VITE_OTP_ENABLED.
 */
import fs from "node:fs";
import dotenv from "dotenv";
import { banner } from "./vercelOtpEnabled.mjs";

export const PROD_SUPABASE_PROJECT_REF = "rpxsyeqskvhjmbkxnpmd";
export const PROD_SUPABASE_URL = `https://${PROD_SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_URL_KEY = "VITE_SUPABASE_URL";
export const ENVIRONMENT_KEY = "VITE_ENVIRONMENT";
export const PROD_BUILD_ENV_DOC = "docs/DEPLOY_OTP_CHECK.md";

/**
 * Merge process env with .env.production the way Vite loadEnv does:
 * existing process.env values win over file values.
 */
export function loadEffectiveProductionEnv(processEnv = process.env, envProductionPath) {
  const env = { ...processEnv };
  if (!envProductionPath || !fs.existsSync(envProductionPath)) {
    return env;
  }
  const parsed = dotenv.parse(fs.readFileSync(envProductionPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
    }
  }
  return env;
}

/**
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateProdBuildEnv(env) {
  const errors = [];
  const url = String(env[SUPABASE_URL_KEY] ?? "").trim().replace(/\/$/, "");
  if (!url) {
    errors.push(`${SUPABASE_URL_KEY} is missing`);
  } else if (!url.includes(PROD_SUPABASE_PROJECT_REF)) {
    errors.push(
      `${SUPABASE_URL_KEY} is not PROD (expected ref ${PROD_SUPABASE_PROJECT_REF}, got ${url})`,
    );
  }

  const environment = String(env[ENVIRONMENT_KEY] ?? "").trim();
  if (environment !== "production") {
    errors.push(
      `${ENVIRONMENT_KEY} must be "production" (got ${JSON.stringify(environment || "(unset)")})`,
    );
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ exit?: boolean }} [opts]
 */
export function assertProdBuildEnv(env, { exit = true } = {}) {
  const result = validateProdBuildEnv(env);
  if (result.ok) return result;

  banner("PROD BUILD BLOCKED — release env mismatch", [
    ...result.errors,
    "APK/web release builds must target PROD Supabase and VITE_ENVIRONMENT=production.",
    `Set values in Vercel Production and/or gitignored .env.production — see ${PROD_BUILD_ENV_DOC}`,
    "Playwright prod-preview builds should use `vite build --mode production`, not `npm run build:prod`.",
  ]);
  if (exit) process.exit(1);
  return result;
}
