import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setAppNavigate, clearAppNavigate } from "@/lib/appNavigate";
import { handlePushNotificationData } from "@/lib/notificationNavigation";
import { consumePendingPushNav } from "@/lib/pendingPushNav";

/** Registers React Router navigate for native push tap deep-links. */
export function PushNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    setAppNavigate(navigate);
    const pending = consumePendingPushNav();
    if (pending) {
      handlePushNotificationData(navigate, pending);
    }
    return () => clearAppNavigate();
  }, [navigate]);

  return null;
}
