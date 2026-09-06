/**
 * Inspect live aaspaaspro.com bundles for compiled OTP behavior (no deploy).
 * Usage: node scripts/probes/inspect-live-otp-flag.mjs
 */
import { writeFileSync } from "node:fs";

const BASE = "https://aaspaaspro.com";
const res = await fetch(BASE + "/");
const html = await res.text();
const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
console.log(JSON.stringify({ status: res.status, scriptCount: scripts.length, scripts: scripts.slice(0, 12) }, null, 2));

const findings = [];
for (const src of scripts) {
  const u = new URL(src, BASE).href;
  const js = await (await fetch(u)).text();
  const idx = js.search(/OTP_ENABLED|otp_pending|signInWithOtp|phoneOtpEnabled|Skip verify|requestPhoneOtp/);
  findings.push({
    src,
    bytes: js.length,
    hasSignInWithOtp: js.includes("signInWithOtp"),
    hasOtpPending: js.includes("otp_pending"),
    hasSkipVerify: /Skip verify|OTP skipped/i.test(js),
    // Vite constant-folds `import.meta.env.VITE_OTP_ENABLED === "true"` to true/false
    foldedTrue: /\b!0\b/.test(js) && /otp_pending/.test(js),
    sample: idx >= 0 ? js.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, " ") : null,
  });
}

// Deeper: find FirstOpen OTP gate patterns in largest chunk
let best = null;
for (const src of scripts) {
  const js = await (await fetch(new URL(src, BASE).href)).text();
  // Look for minified: if(OTP) or conditional around beginOtp / otp_pending
  const patterns = [
    /otp_pending.{0,40}/g,
    /signInWithOtp.{0,40}/g,
    /"true"==="true"/g,
    /"true"===["']true["']/g,
  ];
  const counts = {};
  for (const p of patterns) {
    counts[String(p)] = (js.match(p) || []).length;
  }
  if (!best || js.length > best.len) best = { src, len: js.length, counts };
}

writeFileSync("scripts/probes/.tmp-live-otp-inspect.json", JSON.stringify({ findings, best }, null, 2));
console.log(JSON.stringify({ findings, best }, null, 2));
