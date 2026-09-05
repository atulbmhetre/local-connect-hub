/** Phase D: OTP gates phone registration and returning-vendor login when true (TEST / env). */
export const OTP_ENABLED = import.meta.env.VITE_OTP_ENABLED === "true";

export {
  isValidIndianMobile,
  normalizePhoneDigits,
} from "@/lib/indianPhone";
