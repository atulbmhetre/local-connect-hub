import { supabase } from "@/lib/supabase";

export type SaveNotificationParams = {
  userPhone: string;
  type: string;
  title: string;
  body: string;
  route?: string | null;
  routeParams?: Record<string, string> | null;
  isInformational?: boolean;
};

/** Best-effort inbox row; never throws (push may already have been sent). */
export function saveNotification({
  userPhone,
  type,
  title,
  body,
  route,
  routeParams,
  isInformational = false,
}: SaveNotificationParams): void {
  const phone = userPhone.trim();
  if (!phone) return;

  void (async () => {
    try {
      const { error } = await supabase.from("user_notifications").insert({
        user_phone: phone,
        type,
        title,
        body,
        route: route ?? null,
        route_params: routeParams ?? null,
        is_informational: isInformational,
        is_read: false,
      });
      if (error) {
        console.error("saveNotification", error);
      }
    } catch (err) {
      console.error("saveNotification", err);
    }
  })();
}
