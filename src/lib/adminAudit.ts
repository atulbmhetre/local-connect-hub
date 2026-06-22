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
    .from("admin_actions")
    .insert({
      admin_phone: adminPhone,
      action_type: actionType,
      target_type: targetType,
      target_id: targetId,
      reason: reason?.trim() || null,
    })
    .then(({ error }) => {
      if (error) console.error("logAdminAction", error);
    });
}
