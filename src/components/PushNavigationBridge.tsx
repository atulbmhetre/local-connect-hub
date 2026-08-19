import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setAppNavigate, clearAppNavigate } from "@/lib/appNavigate";
import { handlePushNotificationData, pushDataFromSearchParams } from "@/lib/notificationNavigation";
import { consumePendingPushNav } from "@/lib/pendingPushNav";

/** Registers React Router navigate for native push tap deep-links. */
export function PushNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    setAppNavigate(navigate);
    const fromQuery = pushDataFromSearchParams(window.location.search);
    if (fromQuery) {
      handlePushNotificationData(navigate, fromQuery);
      const url = new URL(window.location.href);
      url.searchParams.delete("push_route");
      url.searchParams.delete("push_route_params");
      const qs = url.searchParams.toString();
      window.history.replaceState(
        {},
        "",
        `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`,
      );
    } else {
      const pending = consumePendingPushNav();
      if (pending) {
        handlePushNotificationData(navigate, pending);
      }
    }
    return () => clearAppNavigate();
  }, [navigate]);

  return null;
}
