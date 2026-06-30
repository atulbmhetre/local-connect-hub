import { supabase, invokeNotifyUser } from "@/lib/supabase";
import { logAdminAction } from "@/lib/adminAudit";
import { getUserPhone } from "@/lib/userIdentity";
import { type Language, t } from "@/lib/strings";

export type WarnFlaggedUserConfig = {
  localizationEnabled: boolean;
  langHindiEnabled: boolean;
  langMarathiEnabled: boolean;
};

export type WarnFlaggedUserResult =
  | { ok: true }
  | { ok: false; error: "warn_count_not_saved" };

export async function warnFlaggedUser(
  phone: string,
  config: WarnFlaggedUserConfig,
): Promise<WarnFlaggedUserResult> {
  const adminPhone = getUserPhone()?.trim();
  if (!adminPhone) {
    return { ok: false, error: "warn_count_not_saved" };
  }

  const { data: langValue, error: langError } = await supabase.rpc("admin_get_user_lang", {
    p_admin_phone: adminPhone,
    p_user_phone: phone,
  });

  if (langError) {
    return { ok: false, error: "warn_count_not_saved" };
  }

  const rawLang = String(langValue ?? "en").trim().toLowerCase();
  let userLang: Language = rawLang === "hi" || rawLang === "mr" ? rawLang : "en";
  if (!config.localizationEnabled) userLang = "en";
  else if (userLang === "hi" && !config.langHindiEnabled) userLang = "en";
  else if (userLang === "mr" && !config.langMarathiEnabled) userLang = "en";

  const title = t(userLang, "warn_user_title");
  const pushBody = t(userLang, "warn_user_push_body");

  void invokeNotifyUser({
    user_phone: phone,
    title,
    body: pushBody,
    type: "account_warning",
  });

  const { data: savedWarnCount, error: warnError } = await supabase.rpc("admin_warn_user", {
    p_admin_phone: adminPhone,
    p_user_phone: phone,
  });

  if (warnError || savedWarnCount == null) {
    return { ok: false, error: "warn_count_not_saved" };
  }

  logAdminAction("warn_user", "user", phone);
  return { ok: true };
}
