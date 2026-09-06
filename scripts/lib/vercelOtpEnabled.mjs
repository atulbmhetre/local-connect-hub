/**
 * Load Vercel credentials from gitignored `.env.vercel.local` (or process env).
 * Never used as Vite build input — build:prod fetches VITE_OTP_ENABLED from Vercel API.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const VERCEL_LOCAL_ENV_PATH = path.join(root, ".env.vercel.local");
export const OTP_KEY = "VITE_OTP_ENABLED";
export const DOC = "docs/DEPLOY_OTP_CHECK.md";

export function banner(title, lines) {
  const bar = "═".repeat(72);
  console.error(`\n${bar}`);
  console.error(`⚠  ${title}`);
  console.error(bar);
  for (const line of lines) console.error(`  ${line}`);
  console.error(`${bar}\n`);
}

export function loadVercelCredentials() {
  if (fs.existsSync(VERCEL_LOCAL_ENV_PATH)) {
    dotenv.config({ path: VERCEL_LOCAL_ENV_PATH, override: false });
  }
  const token = (process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN || "").trim();
  const projectId = (
    process.env.VERCEL_PROJECT_ID ||
    process.env.VERCEL_PROJECT_NAME ||
    ""
  ).trim();
  const teamId = (process.env.VERCEL_TEAM_ID || "").trim();
  return { token, projectId, teamId, localEnvPath: VERCEL_LOCAL_ENV_PATH };
}

function targetIsProduction(target) {
  if (!target) return false;
  if (typeof target === "string") return target === "production";
  if (Array.isArray(target)) return target.includes("production");
  return false;
}

/**
 * @returns {Promise<{ value: string, envId: string | null, projectId: string, teamId: string, token: string }>}
 */
export async function fetchVercelProductionOtpEnabled() {
  // On Vercel’s own builders, Production env (including VITE_OTP_ENABLED) is already
  // injected — same dashboard source, no API token required in the cloud.
  if (process.env.VERCEL === "1") {
    const injected = String(process.env[OTP_KEY] ?? "").trim();
    if (injected !== "true" && injected !== "false") {
      banner("PROD BUILD BLOCKED — Vercel build missing VITE_OTP_ENABLED", [
        "This build is running on Vercel but Production VITE_OTP_ENABLED is not injected.",
        "Set it in the Vercel dashboard (Production), then redeploy.",
        `See ${DOC}`,
      ]);
      process.exit(1);
    }
    return {
      value: injected,
      envId: null,
      projectId: process.env.VERCEL_PROJECT_ID || "",
      teamId: "",
      token: "",
    };
  }

  const { token, projectId, teamId, localEnvPath } = loadVercelCredentials();

  if (!token) {
    banner("PROD BUILD BLOCKED — no Vercel API token", [
      `Create ${path.basename(localEnvPath)} (gitignored) with VERCEL_TOKEN=...`,
      "Also set VERCEL_PROJECT_ID=... (and VERCEL_TEAM_ID=... if under a team).",
      `Copy from .env.vercel.local.example — see ${DOC}`,
      "Refusing to build: VITE_OTP_ENABLED has no silent default.",
    ]);
    process.exit(1);
  }

  if (!projectId) {
    banner("PROD BUILD BLOCKED — VERCEL_PROJECT_ID unset", [
      `Add VERCEL_PROJECT_ID to ${path.basename(localEnvPath)} or the environment.`,
      `See ${DOC}`,
    ]);
    process.exit(1);
  }

  const listQs = new URLSearchParams();
  if (teamId) listQs.set("teamId", teamId);
  const listUrl = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env${listQs.toString() ? `?${listQs}` : ""}`;

  let listRes;
  let listBody;
  try {
    listRes = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    listBody = await listRes.json().catch(() => ({}));
  } catch (err) {
    banner("PROD BUILD BLOCKED — Vercel network/API error", [
      err instanceof Error ? err.message : String(err),
      "Refusing to build with a guessed VITE_OTP_ENABLED.",
      `See ${DOC}`,
    ]);
    process.exit(1);
  }

  if (!listRes.ok) {
    banner("PROD BUILD BLOCKED — Vercel API rejected the request", [
      `HTTP ${listRes.status}: ${listBody?.error?.message || listBody?.message || JSON.stringify(listBody).slice(0, 240)}`,
      "Refusing to build with a guessed VITE_OTP_ENABLED.",
      `See ${DOC}`,
    ]);
    process.exit(1);
  }

  const envs = Array.isArray(listBody?.envs)
    ? listBody.envs
    : Array.isArray(listBody)
      ? listBody
      : [];
  const otpVars = envs.filter((e) => e?.key === OTP_KEY && targetIsProduction(e.target));
  if (otpVars.length === 0) {
    banner("PROD BUILD BLOCKED — Vercel Production missing VITE_OTP_ENABLED", [
      `Project ${projectId} has no Production ${OTP_KEY}.`,
      "Set it in the Vercel dashboard (Production), then rebuild.",
      `See ${DOC}`,
    ]);
    process.exit(1);
  }

  const preferred =
    otpVars.find(
      (e) =>
        Array.isArray(e.target) &&
        e.target.length === 1 &&
        e.target[0] === "production",
    ) || otpVars[0];

  const envId = preferred.id ? String(preferred.id) : null;
  if (!envId) {
    banner("PROD BUILD BLOCKED — Vercel env var has no id", [
      `Cannot decrypt Production ${OTP_KEY} without an env id.`,
      `See ${DOC}`,
    ]);
    process.exit(1);
  }

  // Sensitive/encrypted Production vars need the per-id decrypt endpoint.
  const oneQs = new URLSearchParams({ decrypt: "true" });
  if (teamId) oneQs.set("teamId", teamId);
  const oneUrl = `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}?${oneQs}`;

  let oneRes;
  let oneBody;
  try {
    oneRes = await fetch(oneUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    oneBody = await oneRes.json().catch(() => ({}));
  } catch (err) {
    banner("PROD BUILD BLOCKED — Vercel decrypt request failed", [
      err instanceof Error ? err.message : String(err),
      "Refusing to build with a guessed VITE_OTP_ENABLED.",
    ]);
    process.exit(1);
  }

  if (!oneRes.ok) {
    banner("PROD BUILD BLOCKED — could not decrypt Vercel VITE_OTP_ENABLED", [
      `HTTP ${oneRes.status}: ${oneBody?.error?.message || oneBody?.message || JSON.stringify(oneBody).slice(0, 240)}`,
      "Token may lack permission to decrypt Production env vars.",
      "Refusing to build with a guessed VITE_OTP_ENABLED.",
    ]);
    process.exit(1);
  }

  const value = String(oneBody?.value ?? preferred.value ?? "").trim();
  if (value !== "true" && value !== "false") {
    banner("PROD BUILD BLOCKED — invalid Vercel VITE_OTP_ENABLED", [
      `Expected "true" or "false", got ${JSON.stringify(value).slice(0, 80)}.`,
      "Fix the Production env var in Vercel, then rebuild.",
    ]);
    process.exit(1);
  }

  return { value, envId, projectId, teamId, token };
}

/**
 * Update Production VITE_OTP_ENABLED on Vercel (for tests / ops).
 */
export async function setVercelProductionOtpEnabled(value) {
  if (value !== "true" && value !== "false") {
    throw new Error(`invalid OTP value: ${value}`);
  }
  const current = await fetchVercelProductionOtpEnabled();
  if (!current.envId) {
    throw new Error("Vercel env var has no id — cannot PATCH");
  }
  const qs = new URLSearchParams();
  if (current.teamId) qs.set("teamId", current.teamId);
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(current.projectId)}/env/${encodeURIComponent(current.envId)}${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${current.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value, target: ["production"] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PATCH failed ${res.status}: ${body?.error?.message || body?.message || JSON.stringify(body).slice(0, 240)}`,
    );
  }
  return value;
}
