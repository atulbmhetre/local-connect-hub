/**
 * PROD Auth OTP via anon key only — not the live app.
 * Usage: node scripts/probes/prod-otp-direct.mjs
 *
 * Requires Dashboard Send SMS hook (step D) pointing at PROD sms-hook.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const PROD_REF = "rpxsyeqskvhjmbkxnpmd";
const PHONE_DIGITS = "8888169446";
const E164 = `+91${PHONE_DIGITS}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test.prod"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!url.includes(PROD_REF) || !anon || !service) {
  console.error("HARD STOP: .env.test.prod is not PROD or missing keys");
  process.exit(1);
}

const auth = createClient(url, anon, { auth: { persistSession: false } });
const admin = createClient(url, service, { auth: { persistSession: false } });

const since = new Date(Date.now() - 15_000).toISOString();
const { error: sendErr } = await auth.auth.signInWithOtp({ phone: E164 });
console.log("signInWithOtp", sendErr ? sendErr.message : "ok (no client error)");
if (sendErr) process.exit(1);

let capture = null;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const { data, error } = await admin
    .from("_test_otp_capture")
    .select("phone, otp, created_at")
    .eq("phone", E164)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("capture lookup failed", error.message);
    process.exit(1);
  }
  if (data?.otp) {
    capture = data;
    console.log(`capture after ${(i + 1) * 2.5}s phone=…${PHONE_DIGITS.slice(-4)} otpLen=${data.otp.length}`);
    break;
  }
  console.log(`waiting capture ${i + 1}/24 ...`);
}

if (!capture?.otp) {
  console.error("FAIL: no _test_otp_capture row — Auth hook is probably not enabled on PROD yet");
  process.exit(2);
}

const { error: verifyErr } = await auth.auth.verifyOtp({
  phone: E164,
  token: capture.otp,
  type: "sms",
});
console.log("verifyOtp", verifyErr ? verifyErr.message : "ok");
if (verifyErr) process.exit(1);
console.log("PASS: PROD OTP send+verify (direct API)");
