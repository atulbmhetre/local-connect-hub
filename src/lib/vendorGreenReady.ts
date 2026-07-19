import { toast } from "sonner";
import { supabase, invokeNotifyAdmin } from "@/lib/supabase";
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

function notifyAdminGreenReady(vendorId: string, shopName?: string): void {
  const s = strings[readLang()];
  void invokeNotifyAdmin(
    s.admin_green_ready_title,
    s.admin_green_ready_body.replace("{shop}", shopName?.trim() || "Vendor"),
    {
      type: "vendor_green_ready",
      route: "settings",
      route_params: { vendor_id: vendorId },
    },
  );
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
 * All criteria checks live server-side in vendor_promote_green_pending
 * (business_verified status, photo, selfie, verified UPI, valid phone, not
 * manual verified, not already pending). Promotion failures surface a visible
 * error; a genuine promotion notifies the admin (ready-for-review).
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
    if (data === true) {
      notifyAdminGreenReady(vendorId, opts?.shopName);
      return true;
    }
    return false;
  } catch (err) {
    console.error("checkAndNotifyAdminGreenReady", err);
    const s = strings[readLang()];
    toast.error(s.vendor_green_promote_failed);
    return false;
  }
}

/**
 * Per-business variant: promote one category to green_pending (photo + UPI +
 * selfie checked server-side). Same visibility rules as the account-level
 * helper: errors toast, genuine promotion notifies the admin.
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
    if (data === true) {
      notifyAdminGreenReady(vendorId, opts?.shopName);
      return true;
    }
    return false;
  } catch (err) {
    console.error("checkAndNotifyAdminCategoryGreenReady", err);
    const s = strings[readLang()];
    toast.error(s.vendor_green_promote_failed);
    return false;
  }
}
