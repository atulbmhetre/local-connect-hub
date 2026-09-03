import { useEffect, useRef } from "react";
import {
  subscribeUserNotificationsRealtime,
  type UserNotificationsRealtimeListener,
} from "@/lib/userNotificationsRealtime";

/** Subscribe this instance to the process-wide user-notifications Realtime channel. */
export function useUserNotificationsRealtime(
  phone: string | null,
  onChange: UserNotificationsRealtimeListener,
): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!phone) return;
    return subscribeUserNotificationsRealtime(phone, () => onChangeRef.current());
  }, [phone]);
}
