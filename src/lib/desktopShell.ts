import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

/** Persistent desktop sidebar width (`w-64` = 16rem). */
export const DESKTOP_SIDEBAR_WIDTH_CLASS = "w-64";

/** Offset main content so it sits to the right of the fixed sidebar at `lg+`. */
export const DESKTOP_MAIN_OFFSET_CLASS = "lg:pl-64";

/**
 * Readable content column on desktop. Wider than the phone `max-w-md` column,
 * still capped so mobile-first cards are not stretched full-bleed.
 */
export const DESKTOP_CONTENT_WIDTH_CLASS = "lg:max-w-3xl";

/** Tailwind `lg` — desktop shell must not apply below this. */
export const LG_MEDIA_QUERY = "(min-width: 1024px)";

/** Customer Khata lives on My Orders; vendors keep `/ledger`. */
export const CUSTOMER_KHATA_HASH = "khata";

export function desktopKhataHref(hasVendorId: boolean): string {
  return hasVendorId ? "/ledger" : `/my-orders#${CUSTOMER_KHATA_HASH}`;
}

/** Web-only. Native Capacitor never gets the desktop shell, at any width. */
export function isWebDesktopShell(): boolean {
  return !Capacitor.isNativePlatform();
}

/** True when the viewport is `lg` or wider. Initialized from matchMedia to avoid a flash. */
export function useLgUp(): boolean {
  const [lgUp, setLgUp] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(LG_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(LG_MEDIA_QUERY);
    const onChange = () => setLgUp(mql.matches);
    mql.addEventListener("change", onChange);
    setLgUp(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return lgUp;
}
