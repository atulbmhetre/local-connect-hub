import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { strings, type Language } from "@/lib/strings";

function readLang(): Language {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    return stored === "hi" || stored === "mr" ? stored : "en";
  } catch {
    return "en";
  }
}

function resolvePromotePhone(explicit?: string | null): string | null {
  const fromArg = explicit?.trim() || "";
  if (fromArg) return fromArg;
  return getUserPhone()?.trim() || null;
}

/**
 * After verification-related vendor updates: if green criteria are met but admin
 * has not approved, mark green_pending once (deduped via verification_status).
 *
 * All criteria checks live server-side in vendor_promote_green_pending.
 * Admin notify on genuine promotion is fired by DB trigger when
 * verification_status becomes green_pending.
 *
 * Requires vendor phone ownership. Customer-initiated callers without the
 * vendor's phone (e.g. rating sync) skip silently — they cannot prove ownership.
 */
export async function checkAndNotifyAdminGreenReady(
  vendorId: string,
  opts?: { shopName?: string; vendorPhone?: string | null },
): Promise<boolean> {
  const phone = resolvePromotePhone(opts?.vendorPhone);
  if (!phone) return false;

  try {
    const { data, error } = await supabase.rpc("vendor_promote_green_pending", {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
    });
    if (error) {
      const s = strings[readLang()];
      toast.error(s.vendor_green_promote_failed, { description: error.message });
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("checkAndNotifyAdminGreenReady", err);
    const s = strings[readLang()];
    toast.error(s.vendor_green_promote_failed);
    return false;
  }
}

/**
 * Per-business variant: promote one category to green_pending (photo + UPI +
 * selfie checked server-side). Admin notify is DB-triggered on status change.
 */
export async function checkAndNotifyAdminCategoryGreenReady(
  vendorId: string,
  categoryId: string,
  opts?: { shopName?: string; vendorPhone?: string | null },
): Promise<boolean> {
  const phone = resolvePromotePhone(opts?.vendorPhone);
  if (!phone) return false;

  try {
    const { data, error } = await supabase.rpc("vendor_promote_category_green_pending", {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_category_id: categoryId,
    });
    if (error) {
      const s = strings[readLang()];
      toast.error(s.vendor_green_promote_failed, { description: error.message });
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("checkAndNotifyAdminCategoryGreenReady", err);
    const s = strings[readLang()];
    toast.error(s.vendor_green_promote_failed);
    return false;
  }
}
