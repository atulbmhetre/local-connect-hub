/** Mask 10-digit Indian mobile numbers in free text (feed post body, etc.). */
const INDIAN_MOBILE_IN_TEXT =
  /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g;

export function maskPhoneNumbers(text: string): string {
  return text.replace(INDIAN_MOBILE_IN_TEXT, "••••••••••");
}
