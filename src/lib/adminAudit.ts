import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";

export type AdminActionType =
  | "verify_vendor"
  | "unverify_vendor"
  | "verify_vendor_category"
  | "unverify_vendor_category"
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
  | "admin_check_failed"
  | "force_clear_deletion";

export type AdminTargetType = "vendor" | "user" | "category" | "config" | "vendor_category";

/** Fire-and-forget admin audit row; never blocks the caller. */
export function logAdminAction(
  actionType: AdminActionType,
  targetType: AdminTargetType,
  targetId: string,
  reason?: string | null,
  adminLabel?: string | null,
): void {
  // Label is best-effort only: log_admin_action resolves the real identity
  // server-side from the admin session (auth.uid()) and uses p_admin_phone
  // purely as a fallback, so a missing local label must not skip the audit row.
  const label = adminLabel ?? getUserPhone()?.trim() ?? null;

  void supabase
    .rpc("log_admin_action", {
      p_admin_phone: label,
      p_action_type: actionType,
      p_target_type: targetType,
      p_target_id: targetId,
      p_notes: reason?.trim() || null,
    })
    .then(({ error }) => {
      if (error) console.warn("logAdminAction failed — audit row not written", error);
    });
}
