import { supabase, invokeNotifyVendor } from "@/lib/supabase";
import { logAdminAction } from "@/lib/adminAudit";
import { getUserPhone } from "@/lib/userIdentity";
import { type Language, t } from "@/lib/strings";

export type ApplyVendorWaiveoffConfig = {
  localizationEnabled: boolean;
  langHindiEnabled: boolean;
  langMarathiEnabled: boolean;
};

export type ApplyVendorWaiveoffResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Apply a subscription waive-off via admin_apply_vendor_waiveoff, then notify
 * the vendor in their own language (same admin_get_user_lang resolution as
 * warnFlaggedUser).
 */
export async function applyVendorWaiveoff(
  vendor: { id: string; phone: string | null },
  percent: number,
  months: number,
  config: ApplyVendorWaiveoffConfig,
  adminLabel?: string | null,
): Promise<ApplyVendorWaiveoffResult> {
  const p_admin_phone = adminLabel ?? (getUserPhone()?.trim() || null);

  const { error: applyError } = await supabase.rpc("admin_apply_vendor_waiveoff", {
    p_admin_phone,
    p_vendor_id: vendor.id,
    p_percent: percent,
    p_months: months,
  });
  if (applyError) {
    return { ok: false, error: applyError.message };
  }

  let vendorLang: Language = "en";
  if (vendor.phone?.trim()) {
    const { data: langValue, error: langError } = await supabase.rpc("admin_get_user_lang", {
      p_admin_phone,
      p_user_phone: vendor.phone.trim(),
    });
    if (!langError) {
      const rawLang = String(langValue ?? "en").trim().toLowerCase();
      vendorLang = rawLang === "hi" || rawLang === "mr" ? rawLang : "en";
    }
  }
  if (!config.localizationEnabled) vendorLang = "en";
  else if (vendorLang === "hi" && !config.langHindiEnabled) vendorLang = "en";
  else if (vendorLang === "mr" && !config.langMarathiEnabled) vendorLang = "en";

  const title = t(vendorLang, "waiveoff_push_title");
  const body = t(vendorLang, "waiveoff_push_body")
    .replace("{percent}", String(percent))
    .replace("{months}", String(months));

  void invokeNotifyVendor({
    vendor_id: vendor.id,
    notification_title: title,
    message: body,
    type: "subscription_update",
  });

  logAdminAction(
    "update_config",
    "vendor",
    vendor.id,
    `waiveoff:${percent}%x${months}months`,
    adminLabel,
  );

  return { ok: true };
}
