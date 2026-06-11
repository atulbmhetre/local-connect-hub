import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { formatTimeAgo } from "@/lib/orders";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export type UserNotification = {
  id: string;
  user_phone: string;
  type: string;
  title: string;
  body: string;
  route: string | null;
  route_params: Record<string, string> | null;
  is_informational: boolean;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
};

const ROUTE_PATHS: Record<string, string> = {
  vendor: "/vendor",
  "my-orders": "/my-orders",
  settings: "/settings",
};

function resolveRoutePath(route: string | null): string {
  if (!route?.trim()) return "/";
  const key = route.trim().replace(/^\//, "");
  return ROUTE_PATHS[key] ?? `/${key}`;
}

function navigateFromNotification(
  navigate: ReturnType<typeof useNavigate>,
  route: string | null,
  routeParams: Record<string, string> | null,
): void {
  const path = resolveRoutePath(route);
  const key = route?.trim().replace(/^\//, "") ?? "";
  const params = routeParams ?? {};

  if (key === "my-orders" && params.order_id) {
    navigate(path, { state: { highlightOrderId: params.order_id } });
    return;
  }
  if (key === "vendor" && params.order_id) {
    navigate(path, { state: { highlightOrderId: params.order_id } });
    return;
  }
  if (key === "vendor" && params.vendor_id) {
    navigate(path, { state: { highlightVendorId: params.vendor_id } });
    return;
  }
  if (key === "settings" && params.vendor_id) {
    navigate(path, { state: { highlightVendorId: params.vendor_id } });
    return;
  }
  navigate(path);
}

function formatBadgeCount(n: number): string {
  return n > 9 ? "9+" : String(n);
}

type Props = {
  className?: string;
  /** Added to DB unread count for badge (e.g. pending orders on vendor dashboard). */
  extraCount?: number;
};

export function NotificationBell({ className, extraCount = 0 }: Props) {
  const { s } = useLanguage();
  const navigate = useNavigate();
  const [phone, setPhone] = useState(() => getUserPhone());
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const loadIdRef = useRef(0);

  const refreshUnreadCount = useCallback(async (userPhone: string) => {
    const { count, error } = await supabase
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_phone", userPhone)
      .eq("is_read", false);
    if (error) {
      console.error("NotificationBell unread count", error);
      return;
    }
    setUnreadCount(count ?? 0);
  }, []);

  const loadTray = useCallback(async (userPhone: string) => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    const { data, error } = await supabase
      .from("user_notifications")
      .select(
        "id, user_phone, type, title, body, route, route_params, is_informational, is_read, read_at, created_at",
      )
      .eq("user_phone", userPhone)
      .order("is_read", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(50);
    if (loadId !== loadIdRef.current) return;
    setLoading(false);
    if (error) {
      console.error("NotificationBell load tray", error);
      setNotifications([]);
      return;
    }
    setNotifications((data ?? []) as UserNotification[]);
  }, []);

  const markInformationalRead = useCallback(async (userPhone: string) => {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("user_notifications")
      .update({ is_read: true, read_at: now })
      .eq("user_phone", userPhone)
      .eq("is_informational", true)
      .eq("is_read", false);
    if (error) {
      console.error("NotificationBell mark informational read", error);
      return;
    }
    setNotifications((prev) =>
      prev.map((n) =>
        n.is_informational && !n.is_read ? { ...n, is_read: true, read_at: now } : n,
      ),
    );
    void refreshUnreadCount(userPhone);
  }, [refreshUnreadCount]);

  const markAllRead = useCallback(async (userPhone: string) => {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("user_notifications")
      .update({ is_read: true, read_at: now })
      .eq("user_phone", userPhone)
      .eq("is_read", false);
    if (error) {
      console.error("NotificationBell mark all read", error);
      return;
    }
    setUnreadCount(0);
    void loadTray(userPhone);
  }, [loadTray]);

  const dismissNotification = useCallback(
    async (n: UserNotification) => {
      if (!phone) return;
      setNotifications((prev) => prev.filter((row) => row.id !== n.id));
      if (!n.is_read) {
        setUnreadCount((count) => Math.max(0, count - 1));
      }
      const { error } = await supabase.from("user_notifications").delete().eq("id", n.id);
      if (error) {
        console.error("NotificationBell dismiss", error);
        void loadTray(phone);
        void refreshUnreadCount(phone);
      }
    },
    [phone, loadTray, refreshUnreadCount],
  );

  const clearAll = useCallback(
    async (userPhone: string) => {
      setNotifications([]);
      setUnreadCount(0);
      const { error } = await supabase
        .from("user_notifications")
        .delete()
        .eq("user_phone", userPhone);
      if (error) {
        console.error("NotificationBell clear all", error);
        void loadTray(userPhone);
        void refreshUnreadCount(userPhone);
      }
    },
    [loadTray, refreshUnreadCount],
  );

  useEffect(() => {
    const syncPhone = () => setPhone(getUserPhone());
    syncPhone();
    window.addEventListener("storage", syncPhone);
    return () => window.removeEventListener("storage", syncPhone);
  }, []);

  useEffect(() => {
    if (!phone) {
      setUnreadCount(0);
      setNotifications([]);
      return;
    }
    void refreshUnreadCount(phone);
  }, [phone, refreshUnreadCount]);

  useEffect(() => {
    if (!phone) return;

    const channel = supabase
      .channel(`user-notifications-${phone}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          void refreshUnreadCount(phone);
          void loadTray(phone);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          void refreshUnreadCount(phone);
          void loadTray(phone);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          void refreshUnreadCount(phone);
          void loadTray(phone);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [phone, refreshUnreadCount, loadTray]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!phone) return;
    if (next) {
      void loadTray(phone);
      void markInformationalRead(phone);
    }
  };

  const handleNotificationTap = async (n: UserNotification) => {
    if (!phone) return;
    const now = new Date().toISOString();
    if (!n.is_read) {
      const { error } = await supabase
        .from("user_notifications")
        .update({ is_read: true, read_at: now })
        .eq("id", n.id);
      if (error) {
        console.error("NotificationBell mark read", error);
      } else {
        setNotifications((prev) =>
          prev.map((row) =>
            row.id === n.id ? { ...row, is_read: true, read_at: now } : row,
          ),
        );
        void refreshUnreadCount(phone);
      }
    }
    setOpen(false);
    navigateFromNotification(navigate, n.route, n.route_params);
  };

  const pendingOrderCount = Math.max(0, extraCount);
  const vendorDualBadges = pendingOrderCount > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => handleOpenChange(true)}
        className={cn(
          "relative h-10 w-10 shrink-0 grid place-items-center rounded-xl border border-border bg-card text-foreground active:opacity-90",
          className,
        )}
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {vendorDualBadges ? (
          <>
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -left-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-[10px] font-bold tabular-nums"
                aria-hidden
              >
                {formatBadgeCount(unreadCount)}
              </span>
            )}
            {pendingOrderCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-amber-500 text-amber-950 text-[10px] font-bold tabular-nums"
                aria-hidden
              >
                {formatBadgeCount(pendingOrderCount)}
              </span>
            )}
          </>
        ) : (
          unreadCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-[10px] font-bold tabular-nums"
              aria-hidden
            >
              {formatBadgeCount(unreadCount)}
            </span>
          )
        )}
      </button>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl border-t border-border bg-background max-h-[85vh] flex flex-col p-0 [&>button]:hidden"
        >
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border text-left shrink-0">
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle className="text-foreground">Notifications</SheetTitle>
              {(unreadCount > 0 || notifications.length > 0) && (
                <div className="flex items-center gap-3 shrink-0">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => phone && void markAllRead(phone)}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      {s.notifications_mark_all_read}
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={() => phone && void clearAll(phone)}
                      className="text-xs font-medium text-muted-foreground hover:underline"
                    >
                      {s.notifications_clear_all}
                    </button>
                  )}
                </div>
              )}
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {loading && notifications.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-16 w-16 rounded-full bg-muted border border-border grid place-items-center mb-4">
                  <Bell className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">No notifications yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
                  Order updates and alerts will show up here.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {notifications.map((n) => (
                  <li
                    key={n.id}
                    className={cn(
                      "flex items-stretch rounded-xl border border-border overflow-hidden transition-colors",
                      n.is_read ? "bg-muted/60" : "bg-background shadow-sm",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void handleNotificationTap(n)}
                      className="flex-1 min-w-0 text-left px-3 py-3 active:opacity-90"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground leading-snug min-w-0 flex-1">
                          {n.title}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                          {formatTimeAgo(n.created_at)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                        {n.body}
                      </p>
                    </button>
                    <button
                      type="button"
                      aria-label="Dismiss notification"
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismissNotification(n);
                      }}
                      className="shrink-0 w-9 grid place-items-center text-muted-foreground hover:text-foreground border-l border-border active:opacity-70"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {pendingOrderCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/vendor");
              }}
              className="shrink-0 mx-4 mb-4 mt-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-left text-xs text-foreground leading-relaxed active:opacity-90"
            >
              {s.notifications_pending_orders_note.replace("{count}", String(pendingOrderCount))}
            </button>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
