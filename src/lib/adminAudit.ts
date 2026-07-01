import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";

export type AdminActionType =
  | "verify_vendor"
  | "unverify_vendor"
  | "ban_vendor"
  | "unban_vendor"
  | "warn_user"
  | "ban_user"
  | "unban_user"
  | "approve_category"
  | "reject_category"
  | "update_config"
  | "delete_review"
  | "admin_check_passed"
  | "admin_check_failed";

export type AdminTargetType = "vendor" | "user" | "category" | "config";

/** Fire-and-forget admin audit row; never blocks the caller. */
export function logAdminAction(
  actionType: AdminActionType,
  targetType: AdminTargetType,
  targetId: string,
  reason?: string | null,
): void {
  const adminPhone = getUserPhone()?.trim();
  if (!adminPhone) return;

  void supabase
    .rpc("log_admin_action", {
      p_admin_phone: adminPhone,
      p_action_type: actionType,
      p_target_type: targetType,
      p_target_id: targetId,
      p_notes: reason?.trim() || null,
    })
    .then(({ error }) => {
      if (error) console.error("logAdminAction", error);
    });
}
