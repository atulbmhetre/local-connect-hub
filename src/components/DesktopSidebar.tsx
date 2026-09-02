import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, Home, Newspaper, Settings, ShoppingBag, Store } from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";
import { Switch } from "@/components/ui/switch";
import {
  CUSTOMER_KHATA_HASH,
  DESKTOP_SIDEBAR_WIDTH_CLASS,
  desktopKhataHref,
} from "@/lib/desktopShell";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import {
  readHasVendorId,
  VENDOR_ID_CHANGED_EVENT,
} from "@/lib/vendorSessionSync";

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors",
    isActive
      ? "bg-brand/15 text-brand"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );

export function DesktopSidebar() {
  const { s } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const [hasVendorId, setHasVendorId] = useState(readHasVendorId);
  const vendorModeOn =
    location.pathname === "/vendor" || location.pathname.startsWith("/ledger");
  const khataHref = desktopKhataHref(hasVendorId);
  const khataActive = hasVendorId
    ? location.pathname.startsWith("/ledger")
    : location.pathname === "/my-orders" && location.hash === `#${CUSTOMER_KHATA_HASH}`;

  useEffect(() => {
    const sync = () => setHasVendorId(readHasVendorId());
    window.addEventListener("storage", sync);
    window.addEventListener(VENDOR_ID_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(VENDOR_ID_CHANGED_EVENT, sync);
    };
  }, []);

  return (
    <aside
      data-testid="desktop-sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-background lg:flex",
        DESKTOP_SIDEBAR_WIDTH_CLASS,
      )}
    >
      <NavLink
        to="/"
        end
        data-testid="desktop-sidebar-logo"
        className="flex items-center px-6 pt-8 pb-6"
      >
        <span className="font-display text-xl font-bold text-brand tracking-tight">
          {s.appName}
        </span>
      </NavLink>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 px-3" aria-label={s.appName}>
        <NavLink to="/" end data-testid="desktop-nav-home" className={navItemClass}>
          <Home className="h-5 w-5 shrink-0" aria-hidden />
          {s.nav_home}
        </NavLink>
        <NavLink to="/feed" data-testid="desktop-nav-feed" className={navItemClass}>
          <Newspaper className="h-5 w-5 shrink-0" aria-hidden />
          {s.nav_feed}
        </NavLink>
        <NavLink
          to="/my-orders"
          data-testid="desktop-nav-orders"
          className={({ isActive }) =>
            navItemClass({
              isActive: isActive && location.hash !== `#${CUSTOMER_KHATA_HASH}`,
            })
          }
        >
          <ShoppingBag className="h-5 w-5 shrink-0" aria-hidden />
          {s.nav_orders}
        </NavLink>
        <NavLink
          to={khataHref}
          data-testid="desktop-nav-khata"
          className={() => navItemClass({ isActive: khataActive })}
        >
          <BookOpen className="h-5 w-5 shrink-0" aria-hidden />
          {s.khata_wordLabel}
        </NavLink>
        <NotificationBell
          layout="nav"
          navLabel={s.notif_bell_title}
          className="text-muted-foreground hover:bg-muted hover:text-foreground"
        />
        <div className="flex items-center gap-3 rounded-xl px-3 py-3">
          <Store className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 text-sm font-medium text-muted-foreground">
            {s.vendor_mode_title}
          </span>
          <Switch
            checked={vendorModeOn}
            onCheckedChange={(on) => navigate(on ? "/vendor" : "/")}
            aria-label={s.vendor_mode_title}
            data-testid="desktop-vendor-mode-toggle"
          />
        </div>
        <NavLink to="/settings" data-testid="desktop-nav-settings" className={navItemClass}>
          <Settings className="h-5 w-5 shrink-0" aria-hidden />
          {s.nav_settings}
        </NavLink>
      </nav>
    </aside>
  );
}
