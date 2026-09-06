/**
 * Read PROD Auth rate limits via Management API (CLI token from PasswordVault).
 * Does not print the token. Usage: node scripts/probes/prod-auth-sms-rate-limit.mjs [set N]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REF = "rpxsyeqskvhjmbkxnpmd";
const setArg = process.argv[2] === "set" ? Number(process.argv[3]) : null;

function resolveToken() {
  const fromEnv = (process.env.SUPABASE_ACCESS_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $vault = New-Object Windows.Security.Credentials.PasswordVault",
    "  $creds = $vault.RetrieveAll() | Where-Object { $_.Resource -match 'Supabase|supabase' }",
    "  foreach ($c in $creds) {",
    "    $c.RetrievePassword()",
    "    if ($c.Password) { Write-Output $c.Password; break }",
    "  }",
    "} catch {}",
  ].join("; ");

  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
    }).trim();
    if (out) return out.split(/\r?\n/).filter(Boolean).pop();
  } catch {
    /* fall through */
  }

  for (const p of [
    path.join(os.homedir(), "AppData", "Roaming", "supabase", "access-token"),
    path.join(os.homedir(), ".config", "supabase", "access-token"),
    path.join(os.homedir(), ".supabase", "access-token"),
  ]) {
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t;
    }
  }
  return "";
}

const token = resolveToken();
if (!token) {
  console.error("NO_TOKEN: set SUPABASE_ACCESS_TOKEN or ensure supabase CLI is logged in");
  process.exit(2);
}

async function getAuthConfig() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("GET_FAIL", res.status, JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  return body;
}

function pickRelevant(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (
      k.startsWith("rate_limit_") ||
      k.startsWith("hook_send_sms") ||
      k === "external_phone_enabled" ||
      k === "sms_provider" ||
      k === "sms_max_frequency"
    ) {
      out[k] = body[k];
    }
  }
  return out;
}

const before = await getAuthConfig();
console.log("BEFORE", JSON.stringify(pickRelevant(before), null, 2));

if (setArg != null && Number.isFinite(setArg) && setArg > 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rate_limit_sms_sent: setArg }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("PATCH_FAIL", res.status, JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }
  console.log("AFTER", JSON.stringify(pickRelevant(body), null, 2));
  console.log(`UPDATED rate_limit_sms_sent -> ${setArg}`);
}
