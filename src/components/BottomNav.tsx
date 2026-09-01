import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { Home, Store, Settings, Newspaper, ShoppingBag } from "lucide-react";
import { APP_COLUMN_CLASS } from "@/lib/appColumn";
import { isWebDesktopShell } from "@/lib/desktopShell";
import { cn } from "@/lib/utils";
import {
  readHasVendorId,
  readIsVendorActive,
  VENDOR_ACTIVE_CHANGED_EVENT,
  VENDOR_ID_CHANGED_EVENT,
} from "@/lib/vendorSessionSync";
import { useLanguage } from "@/lib/language";

export const BottomNav = () => {
  const { s } = useLanguage();
  const [hasVendorId, setHasVendorId] = useState(readHasVendorId);
  const [isVendorActive, setIsVendorActive] = useState(readIsVendorActive);

  const baseTabs = [
    { to: "/", label: s.nav_home, Icon: Home },
    { to: "/feed", label: s.nav_feed, Icon: Newspaper },
    { to: "/my-orders", label: s.nav_orders, Icon: ShoppingBag },
  ];

  const vendorTab = { to: "/vendor", label: s.nav_vendor, Icon: Store };

  const settingsTab = { to: "/settings", label: s.nav_settings, Icon: Settings };

  const navTestIds: Record<string, string> = {
    "/": "nav-home",
    "/feed": "nav-feed",
    "/my-orders": "nav-orders",
    "/vendor": "nav-vendor",
    "/settings": "nav-settings",
  };

  const tabs = hasVendorId
    ? [...baseTabs, vendorTab, settingsTab]
    : [...baseTabs, settingsTab];

  useEffect(() => {
    const syncFromStorage = () => {
      setHasVendorId(readHasVendorId());
      setIsVendorActive(readIsVendorActive());
    };
    const onActive = (e: Event) =>
      setIsVendorActive(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(VENDOR_ACTIVE_CHANGED_EVENT, onActive as EventListener);
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(VENDOR_ID_CHANGED_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener(VENDOR_ACTIVE_CHANGED_EVENT, onActive as EventListener);
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(VENDOR_ID_CHANGED_EVENT, syncFromStorage);
    };
  }, []);

  const hideOnDesktop = isWebDesktopShell();

  return (
    <nav
      className={cn(
        "fixed bottom-0 inset-x-0 z-40 pointer-events-none",
        hideOnDesktop && "lg:hidden",
      )}
    >
      <div
        data-testid="bottom-nav-chrome"
        className={`${APP_COLUMN_CLASS} pointer-events-auto bg-card/90 backdrop-blur-xl border-t border-border`}
      >
      <div className={`grid ${hasVendorId ? "grid-cols-5" : "grid-cols-4"}`}>
        {tabs.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end
            data-testid={navTestIds[to]}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium transition-colors ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`
            }
          >
            {({ isActive }) => {
              const showLiveDot =
                to === "/vendor" && hasVendorId && isVendorActive;
              const vendorLabel =
                to === "/vendor" && hasVendorId
                  ? isVendorActive
                    ? s.nav_vendor_online
                    : s.nav_vendor_offline
                  : label;
              return (
                <>
                  <span className="relative">
                    <Icon
                      className={`h-5 w-5 ${isActive ? "scale-110" : ""} transition-transform`}
                    />
                    {showLiveDot && <span className="live-dot" aria-hidden />}
                  </span>
                  <span>{vendorLabel}</span>
                </>
              );
            }}
          </NavLink>
        ))}
      </div>
      <div className="h-[env(safe-area-inset-bottom)] bg-card/90" />
      </div>
    </nav>
  );
};
