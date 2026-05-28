import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { Home, Store, Settings, Newspaper, ShoppingBag } from "lucide-react";
import {
  readHasVendorId,
  VENDOR_ID_CHANGED_EVENT,
} from "@/lib/vendorSessionSync";
import { useLanguage } from "@/lib/language";

export const BottomNav = () => {
  const { s } = useLanguage();
  const [hasVendorId, setHasVendorId] = useState(readHasVendorId);
  // Listen for the vendor "Ready to Help" flag so the Vendor tab can pulse.
  const [vendorLive, setVendorLive] = useState(
    () => localStorage.getItem("aaspaas:vendor_live") === "1",
  );

  const baseTabs = [
    { to: "/", label: s.nav_home, Icon: Home },
    { to: "/feed", label: s.nav_feed, Icon: Newspaper },
    { to: "/my-orders", label: s.nav_orders, Icon: ShoppingBag },
  ];

  const vendorTab = { to: "/vendor", label: s.nav_vendor, Icon: Store };

  const settingsTab = { to: "/settings", label: s.nav_settings, Icon: Settings };

  const tabs = hasVendorId
    ? [...baseTabs, vendorTab, settingsTab]
    : [...baseTabs, settingsTab];
  useEffect(() => {
    const syncFromStorage = () => {
      setHasVendorId(readHasVendorId());
      setVendorLive(localStorage.getItem("aaspaas:vendor_live") === "1");
    };
    const onLive = (e: Event) =>
      setVendorLive(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener("aaspaas:vendor_live", onLive as EventListener);
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(VENDOR_ID_CHANGED_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener("aaspaas:vendor_live", onLive as EventListener);
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(VENDOR_ID_CHANGED_EVENT, syncFromStorage);
    };
  }, []);

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-card/90 backdrop-blur-xl border-t border-border">
      <div className={`mx-auto max-w-md grid ${hasVendorId ? "grid-cols-5" : "grid-cols-4"}`}>
        {tabs.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium transition-colors ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`
            }
          >
            {({ isActive }) => {
              const showLive =
                to === "/vendor" && hasVendorId && vendorLive;
              const vendorLabel =
                to === "/vendor" && hasVendorId
                  ? vendorLive
                    ? "ME · Online"
                    : "ME - Offline"
                  : label;
              return (
                <>
                  <span className="relative">
                    <Icon
                      className={`h-5 w-5 ${isActive ? "scale-110" : ""} ${
                        showLive ? "text-secondary" : ""
                      } transition-transform`}
                    />
                    {showLive && <span className="live-dot" aria-hidden />}
                  </span>
                  <span className={showLive ? "text-secondary" : ""}>
                    {vendorLabel}
                  </span>
                </>
              );
            }}
          </NavLink>
        ))}
      </div>
      <div className="h-[env(safe-area-inset-bottom)] bg-card/90" />
    </nav>
  );
};
