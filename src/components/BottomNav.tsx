import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { Home, Store, Settings } from "lucide-react";

const tabs = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/vendor", label: "Vendor", Icon: Store },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export const BottomNav = () => {
  // Listen for the vendor "Ready to Help" flag so the Vendor tab can pulse.
  const [vendorLive, setVendorLive] = useState(
    () => localStorage.getItem("aaspaas:vendor_live") === "1",
  );
  useEffect(() => {
    const onLive = (e: Event) =>
      setVendorLive(!!(e as CustomEvent<boolean>).detail);
    const onStorage = () =>
      setVendorLive(localStorage.getItem("aaspaas:vendor_live") === "1");
    window.addEventListener("aaspaas:vendor_live", onLive as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("aaspaas:vendor_live", onLive as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-card/90 backdrop-blur-xl border-t border-border">
      <div className="mx-auto max-w-md grid grid-cols-3">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium transition-colors ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`
            }
          >
            {({ isActive }) => {
              const showLive = to === "/vendor" && vendorLive;
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
                    {showLive ? "ON · Live" : label}
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
