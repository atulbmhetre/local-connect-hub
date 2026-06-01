import { supabase, meetsGreenCriteria, type Vendor } from "@/lib/supabase";
import { saveNotification } from "@/lib/notifications";
import { strings, type Language } from "@/lib/strings";

const ADMIN_PHONE_FALLBACK = "8888169446";

function localizedStrings() {
  const stored = localStorage.getItem("aaspaas:language");
  const lang: Language = stored === "hi" || stored === "mr" ? stored : "en";
  return strings[lang];
}

/**
 * After verification-related vendor updates: if green criteria are met but admin
 * has not approved, notify admin once (deduped via verification_status green_pending).
 */
export async function checkAndNotifyAdminGreenReady(vendorId: string): Promise<void> {
  try {
    const { data: vendor, error } = await supabase
      .from("vendors")
      .select(
        "id, shop_name, phone, shop_photo_url, upi_verified, verification_status, is_manual_verified",
      )
      .eq("id", vendorId)
      .maybeSingle();

    if (error || !vendor) return;

    const v = vendor as Vendor;
    if (v.verification_status === "green_pending") return;
    if (v.is_manual_verified) return;
    if (!meetsGreenCriteria(v)) return;

    const { data: updated, error: updateErr } = await supabase
      .from("vendors")
      .update({ verification_status: "green_pending" })
      .eq("id", vendorId)
      .neq("verification_status", "green_pending")
      .eq("is_manual_verified", false)
      .select("shop_name")
      .maybeSingle();

    if (updateErr || !updated) return;

    const s = localizedStrings();
    const shopName = String(updated.shop_name ?? v.shop_name ?? "Vendor").trim();
    const title = s.admin_green_ready_title;
    const body = s.admin_green_ready_body.replace("{shop}", shopName);

    const { data: configRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "admin_phone")
      .maybeSingle();
    const adminPhone = configRow?.value?.trim() || ADMIN_PHONE_FALLBACK;

    saveNotification({
      userPhone: adminPhone,
      type: "admin_alert",
      title,
      body,
      route: "settings",
      routeParams: { vendor_id: vendorId },
      isInformational: false,
    });
  } catch (err) {
    console.error("checkAndNotifyAdminGreenReady", err);
  }
}
