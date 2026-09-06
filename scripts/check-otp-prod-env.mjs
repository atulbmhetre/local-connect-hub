/**
 * Print Vercel Production VITE_OTP_ENABLED (no build).
 * Usage: npm run check:otp-prod
 */
import { OTP_KEY, fetchVercelProductionOtpEnabled } from "./lib/vercelOtpEnabled.mjs";

const { value } = await fetchVercelProductionOtpEnabled();
console.log(`[check:otp-prod] Vercel Production ${OTP_KEY}=${JSON.stringify(value)}`);
