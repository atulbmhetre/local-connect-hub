import { supabase } from "@/lib/supabase";
import { logAdminAction } from "@/lib/adminAudit";
import { getUserPhone } from "@/lib/userIdentity";

export type WarnFlaggedUserConfig = {
  localizationEnabled: boolean;
  langHindiEnabled: boolean;
  langMarathiEnabled: boolean;
};

export type WarnFlaggedUserResult =
  | { ok: true }
  | { ok: false; error: "warn_count_not_saved" };

/**
 * Increment warn_count via admin_warn_user. Account-warning notify is fired by
 * the DB trigger on users.warn_count (must run AFTER the RPC write).
 */
export async function warnFlaggedUser(
  phone: string,
  _config: WarnFlaggedUserConfig,
  adminLabel?: string | null,
): Promise<WarnFlaggedUserResult> {
  const p_admin_phone = adminLabel ?? (getUserPhone()?.trim() || null);

  const { data: savedWarnCount, error: warnError } = await supabase.rpc("admin_warn_user", {
    p_admin_phone,
    p_user_phone: phone,
  });

  if (warnError || savedWarnCount == null) {
    return { ok: false, error: "warn_count_not_saved" };
  }

  logAdminAction("warn_user", "user", phone, null, adminLabel);
  return { ok: true };
}
