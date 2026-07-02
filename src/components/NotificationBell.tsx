import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { formatTimeAgo } from "@/lib/orders";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { navigateFromNotification } from "@/lib/notificationNavigation";

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
    const { data, error } = await supabase.rpc("get_user_notifications", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
      p_limit: 100,
    });
    if (error) {
      console.error("NotificationBell unread count", error);
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as UserNotification[];
    setUnreadCount(rows.filter((n) => !n.is_read).length);
  }, []);

  const loadTray = useCallback(async (userPhone: string) => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    const { data, error } = await supabase.rpc("get_user_notifications", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
      p_limit: 50,
    });
    if (loadId !== loadIdRef.current) return;
    setLoading(false);
    if (error) {
      console.error("NotificationBell load tray", error);
      setNotifications([]);
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as UserNotification[];
    setNotifications(rows);
    setUnreadCount(rows.filter((n) => !n.is_read).length);
  }, []);

  const markInformationalRead = useCallback(async (userPhone: string) => {
    const { error } = await supabase.rpc("mark_user_notifications_read", {
      p_user_phone: userPhone,
      p_informational_only: true,
    });
    if (error) {
      console.error("NotificationBell mark informational read", error);
      return;
    }
    const now = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) =>
        n.is_informational && !n.is_read ? { ...n, is_read: true, read_at: now } : n,
      ),
    );
    void refreshUnreadCount(userPhone);
  }, [refreshUnreadCount]);

  const markAllRead = useCallback(async (userPhone: string) => {
    const now = new Date().toISOString();
    const { error } = await supabase.rpc("mark_user_notifications_read", {
      p_user_phone: userPhone,
      p_informational_only: false,
    });
    if (error) {
      console.error("NotificationBell mark all read", error);
      return;
    }
    setUnreadCount(0);
    setNotifications((prev) =>
      prev.map((n) => (!n.is_read ? { ...n, is_read: true, read_at: now } : n)),
    );
    await loadTray(userPhone);
  }, [loadTray]);

  const handleMarkAllRead = useCallback(async () => {
    const userPhone = getUserPhone();
    if (!userPhone) {
      console.error("NotificationBell mark all read: no user phone");
      return;
    }
    await markAllRead(userPhone);
  }, [markAllRead]);

  const dismissNotification = useCallback(
    async (n: UserNotification) => {
      if (!phone) return;
      setNotifications((prev) => prev.filter((row) => row.id !== n.id));
      if (!n.is_read) {
        setUnreadCount((count) => Math.max(0, count - 1));
      }
      const { error } = await supabase.rpc("delete_user_notification", {
        p_user_phone: phone,
        p_notification_id: n.id,
      });
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
      const { error } = await supabase.rpc("clear_user_notifications", {
        p_user_phone: userPhone,
      });
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
    const userPhone = getUserPhone();
    if (userPhone) setPhone(userPhone);
    const activePhone = userPhone ?? phone;
    if (!activePhone) return;
    if (next) {
      void loadTray(activePhone);
      void markInformationalRead(activePhone);
    }
  };

  const handleNotificationTap = async (n: UserNotification) => {
    if (!phone) return;
    const now = new Date().toISOString();
    if (!n.is_read) {
      const { error } = await supabase.rpc("mark_user_notification_read", {
        p_user_phone: phone,
        p_notification_id: n.id,
      });
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
        aria-label={s.notif_bell_aria_label}
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
              <SheetTitle className="text-foreground">{s.notif_bell_title}</SheetTitle>
              {(unreadCount > 0 || notifications.length > 0) && (
                <div className="flex items-center gap-3 shrink-0">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleMarkAllRead()}
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
              <p className="text-sm text-muted-foreground text-center py-8">{s.notif_bell_loading}</p>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-16 w-16 rounded-full bg-muted border border-border grid place-items-center mb-4">
                  <Bell className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{s.notif_bell_empty_title}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
                  {s.notif_bell_empty_body}
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
                      aria-label={s.notif_bell_dismiss_aria}
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
