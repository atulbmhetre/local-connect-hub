import { toast } from "sonner";

export type BaseTypeValue = "" | "shop" | "home" | "none";
export type ReachChoiceValue = "" | "customer" | "vendor" | "both";
export type AvailabilityMode = "help" | "delivery" | "appointment";

export const REG_GUIDANCE_TOAST_MS = 4500;

export function baseTypeToVendorType(baseType: BaseTypeValue): "shop" | "home" | "visiting" | "" {
  if (baseType === "shop") return "shop";
  if (baseType === "home") return "home";
  if (baseType === "none") return "visiting";
  return "";
}

export function vendorTypeToBaseType(
  vendorType: string | null | undefined,
): BaseTypeValue {
  const v = String(vendorType ?? "").trim().toLowerCase();
  if (v === "shop") return "shop";
  if (v === "home") return "home";
  if (v === "visiting") return "none";
  return "";
}

export function reachChoiceFromFlags(
  servesAtVendor: boolean | null | undefined,
  servesAtCustomer: boolean | null | undefined,
): ReachChoiceValue {
  const atVendor = servesAtVendor === true;
  const atCustomer = servesAtCustomer === true;
  if (atVendor && atCustomer) return "both";
  if (atCustomer) return "customer";
  if (atVendor) return "vendor";
  return "";
}

export function reachFlagsFromChoice(choice: ReachChoiceValue): {
  serves_at_vendor_place: boolean;
  serves_at_customer_place: boolean;
} | null {
  if (choice === "customer") {
    return { serves_at_vendor_place: false, serves_at_customer_place: true };
  }
  if (choice === "vendor") {
    return { serves_at_vendor_place: true, serves_at_customer_place: false };
  }
  if (choice === "both") {
    return { serves_at_vendor_place: true, serves_at_customer_place: true };
  }
  return null;
}

export function showRegistrationGuidanceToast(message: string): void {
  toast(message, {
    duration: REG_GUIDANCE_TOAST_MS,
    dismissible: false,
  });
}

/**
 * True when a meaningful share of the string's letters fall outside the
 * basic Latin + Latin-1 Supplement range (covers Devanagari, other Indic
 * scripts, etc.). Latin-only heuristics below (vowel/keyboard-mash checks)
 * don't apply to these — they false-flag real names like "राज" or "श्री".
 */
function hasSignificantNonLatinScript(raw: string): boolean {
  const letters = raw.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const nonLatin = letters.filter((ch) => (ch.codePointAt(0) ?? 0) > 0xff);
  return nonLatin.length / letters.length >= 0.3;
}

export function looksLikeGibberish(s: string): boolean {
  const raw = s.trim();
  const t = raw.toLowerCase();
  if (t.length < 2) return true;
  const nonLatin = hasSignificantNonLatinScript(raw);
  if (!nonLatin && !/[aeiouy]/.test(t)) return true;
  // Repeated letters only — shop/plot/phone numbers often contain digit runs (0000, 1111).
  if (/(\p{L})\1{3,}/u.test(raw)) return true;
  if (!nonLatin) {
    if (/^[asdfghjkl;]+$/.test(t) && t.length > 4) return true;
    if (/^[qwertyuiop]+$/.test(t) && t.length > 4) return true;
  }
  return false;
}

export function resolveRegistrationShopName(
  baseType: BaseTypeValue,
  ownerName: string,
  shopNameValue: string,
): string {
  if (baseType === "shop") return shopNameValue.trim();
  if (baseType === "home") {
    const brand = shopNameValue.trim();
    return brand.length > 0 ? brand : ownerName.trim();
  }
  return ownerName.trim();
}

export const MAX_REG_CATEGORIES = 5;
