/**
 * Flip Vercel Production VITE_OTP_ENABLED, run build:prod, verify injection, restore.
 * Usage: node scripts/probes/verify-vercel-otp-build.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OTP_KEY,
  fetchVercelProductionOtpEnabled,
  setVercelProductionOtpEnabled,
} from "../lib/vercelOtpEnabled.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distJsGlob = () => {
  const dir = path.join(root, "dist", "assets");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
};

function otpPendingCount() {
  let n = 0;
  for (const f of distJsGlob()) {
    const js = fs.readFileSync(f, "utf8");
    n += js.split("otp_pending").length - 1;
  }
  return n;
}

function runBuild() {
  const r = spawnSync("npm", ["run", "build:prod"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: process.env,
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  return { status: r.status, out };
}

const original = await fetchVercelProductionOtpEnabled();
console.log(`original Vercel ${OTP_KEY}=${JSON.stringify(original.value)}`);

const flipped = original.value === "true" ? "false" : "true";
console.log(`temporarily setting Vercel Production ${OTP_KEY}=${JSON.stringify(flipped)}`);
await setVercelProductionOtpEnabled(flipped);

let restored = false;
try {
  const confirm = await fetchVercelProductionOtpEnabled();
  if (confirm.value !== flipped) {
    throw new Error(`Vercel still ${confirm.value} after PATCH to ${flipped}`);
  }

  const { status, out } = runBuild();
  console.log(out);
  if (status !== 0) throw new Error(`build:prod failed with status ${status}`);

  const expectLine = `[build:prod] ${OTP_KEY}=${JSON.stringify(flipped)}`;
  if (!out.includes(expectLine)) {
    throw new Error(`build log missing ${expectLine}`);
  }

  const pending = otpPendingCount();
  console.log(`dist otp_pending occurrences after build with ${flipped}: ${pending}`);
  if (flipped === "true" && pending < 1) {
    throw new Error("expected otp_pending in dist when OTP true");
  }
  if (flipped === "false" && pending > 0) {
    // soft signal — dead-code elim may leave string; primary proof is expectLine
    console.warn("note: otp_pending still present in dist (string may remain); log injection is authoritative");
  }

  console.log("PASS: build:prod picked up flipped Vercel value with no local OTP file edit");
} finally {
  console.log(`restoring Vercel Production ${OTP_KEY}=${JSON.stringify(original.value)}`);
  await setVercelProductionOtpEnabled(original.value);
  restored = true;
  const back = await fetchVercelProductionOtpEnabled();
  if (back.value !== original.value) {
    console.error(`RESTORE FAILED — Vercel is ${back.value}, expected ${original.value}`);
    process.exit(2);
  }
  console.log(`restored OK (${OTP_KEY}=${JSON.stringify(back.value)})`);
}

if (!restored) process.exit(2);
process.exit(0);
