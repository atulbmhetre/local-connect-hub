import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";

const FEED_NOTIFICATIONS_CHANGED = "aaspaas:feed_notifications_changed";

export function useFeedNotificationsEnabled() {
  const { s } = useLanguage();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setEnabled(detail);
    };
    window.addEventListener(FEED_NOTIFICATIONS_CHANGED, onChange);
    return () => window.removeEventListener(FEED_NOTIFICATIONS_CHANGED, onChange);
  }, []);

  useEffect(() => {
    const phone = getUserPhone();
    if (!phone) return;
    const deviceId = getDeviceId();
    void supabase
      .from("user_devices")
      .select("feed_notifications_enabled")
      .eq("user_phone", phone)
      .eq("device_id", deviceId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.feed_notifications_enabled != null) {
          setEnabled(data.feed_notifications_enabled);
        }
      });
  }, []);

  const onCheckedChange = useCallback((checked: boolean) => {
    setEnabled(checked);
    window.dispatchEvent(new CustomEvent(FEED_NOTIFICATIONS_CHANGED, { detail: checked }));
    const phone = getUserPhone();
    if (!phone) return;
    const deviceId = getDeviceId();
    void supabase
      .from("user_devices")
      .update({ feed_notifications_enabled: checked })
      .eq("user_phone", phone)
      .eq("device_id", deviceId)
      .then(({ error }) => {
        if (!error) toast.success(s.settings_feedNotificationsSaved);
      });
  }, [s.settings_feedNotificationsSaved]);

  return { enabled, onCheckedChange };
}
