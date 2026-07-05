import { useEffect, useState } from "react";

/** Synchronous online check; safe in SSR/tests. */
export function getNavigatorOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * Tracks browser online/offline state via `navigator.onLine` and window events.
 * No Capacitor Network plugin — `@capacitor/network` is not in package.json.
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(getNavigatorOnline);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { isOnline };
}
