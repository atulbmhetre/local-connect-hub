import { NavLink } from "react-router-dom";
import { Home, Store, Settings } from "lucide-react";

const tabs = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/vendor", label: "Vendor", Icon: Store },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export const BottomNav = () => (
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
          {({ isActive }) => (
            <>
              <Icon className={`h-5 w-5 ${isActive ? "scale-110" : ""} transition-transform`} />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </div>
    <div className="h-[env(safe-area-inset-bottom)] bg-card/90" />
  </nav>
);
