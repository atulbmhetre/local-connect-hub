import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { useUserNotificationsRealtime } from "@/hooks/useUserNotificationsRealtime";
import { supabase } from "@/lib/supabase";
import {
  ensureUserDeviceLink,
  getUserPhone,
  USER_PHONE_CHANGED_EVENT,
} from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { formatTimeAgo } from "@/lib/orders";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useOverlayBack } from "@/lib/overlayBackBridge";
import { navigateFromNotification } from "@/lib/notificationNavigation";

/** Poll interval matching Home help-banner OTP-off Realtime fallback. */
export const NOTIFICATION_BELL_POLL_MS = 60_000;

const NOTIF_BODY_EXPAND_CHARS = 90;

function notificationBodyNeedsExpand(body: string): boolean {
  return body.trim().length > NOTIF_BODY_EXPAND_CHARS || body.split("\n").length > 2;
}

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
  return n > 99 ? "99+" : String(n);
}

type Props = {
  className?: string;
  /** Added to DB unread count for badge (e.g. pending orders on vendor dashboard). */
  extraCount?: number;
  /** `nav` is the labeled desktop-sidebar row; default is the header icon button. */
  layout?: "icon" | "nav";
  navLabel?: string;
};

export function NotificationBell({
  className,
  extraCount = 0,
  layout = "icon",
  navLabel,
}: Props) {
  const { s } = useLanguage();
  const navigate = useNavigate();
  const [phone, setPhone] = useState(() => getUserPhone());
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const loadIdRef = useRef(0);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const refreshUnreadCount = useCallback(async (userPhone: string) => {
    await ensureUserDeviceLink(userPhone);
    const { data, error } = await supabase.rpc("get_user_unread_notification_count", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
    });
    if (error) {
      console.error("NotificationBell unread count", error);
      captureError(error, {
        notificationSurface: "bell",
        operation: "get_user_unread_notification_count",
      });
      return;
    }
    setUnreadCount(typeof data === "number" ? data : Number(data) || 0);
  }, []);

  const loadTray = useCallback(async (userPhone: string) => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    setLoadError(false);
    await ensureUserDeviceLink(userPhone);
    const { data, error } = await supabase.rpc("get_user_notifications", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
      p_limit: 50,
    });
    if (loadId !== loadIdRef.current) return;
    setLoading(false);
    if (error) {
      console.error("NotificationBell load tray", error);
      captureError(error, {
        notificationSurface: "bell",
        operation: "get_user_notifications",
      });
      setNotifications([]);
      setLoadError(true);
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as UserNotification[];
    setNotifications(rows);
    setLoadError(false);
  }, []);

  const markInformationalRead = useCallback(async (userPhone: string) => {
    await ensureUserDeviceLink(userPhone);
    const { error } = await supabase.rpc("mark_user_notifications_read", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
      p_informational_only: true,
    });
    if (error) {
      console.error("NotificationBell mark informational read", error);
      captureError(error, {
        notificationSurface: "bell",
        operation: "mark_user_notifications_read",
      });
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
    await ensureUserDeviceLink(userPhone);
    const { error } = await supabase.rpc("mark_user_notifications_read", {
      p_user_phone: userPhone,
      p_device_id: getDeviceId(),
      p_informational_only: false,
    });
    if (error) {
      console.error("NotificationBell mark all read", error);
      captureError(error, {
        notificationSurface: "bell",
        operation: "mark_user_notifications_read",
      });
      return;
    }
    setUnreadCount(0);
    setNotifications((prev) =>
      prev.map((n) => (!n.is_read ? { ...n, is_read: true, read_at: now } : n)),
    );
    if (openRef.current) {
      await loadTray(userPhone);
    }
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
      await ensureUserDeviceLink(phone);
      const { error } = await supabase.rpc("delete_user_notification", {
        p_user_phone: phone,
        p_device_id: getDeviceId(),
        p_notification_id: n.id,
      });
      if (error) {
        console.error("NotificationBell dismiss", error);
        captureError(error, {
          notificationSurface: "bell",
          operation: "delete_user_notification",
        });
        if (openRef.current) void loadTray(phone);
        void refreshUnreadCount(phone);
      }
    },
    [phone, loadTray, refreshUnreadCount],
  );

  const clearAll = useCallback(
    async (userPhone: string) => {
      setNotifications([]);
      setUnreadCount(0);
      await ensureUserDeviceLink(userPhone);
      const { error } = await supabase.rpc("clear_user_notifications", {
        p_user_phone: userPhone,
        p_device_id: getDeviceId(),
      });
      if (error) {
        console.error("NotificationBell clear all", error);
        captureError(error, {
          notificationSurface: "bell",
          operation: "clear_user_notifications",
        });
        if (openRef.current) void loadTray(userPhone);
        void refreshUnreadCount(userPhone);
      }
    },
    [loadTray, refreshUnreadCount],
  );

  useEffect(() => {
    const syncPhone = () => setPhone(getUserPhone());
    syncPhone();
    window.addEventListener("storage", syncPhone);
    window.addEventListener(USER_PHONE_CHANGED_EVENT, syncPhone);
    return () => {
      window.removeEventListener("storage", syncPhone);
      window.removeEventListener(USER_PHONE_CHANGED_EVENT, syncPhone);
    };
  }, []);

  useEffect(() => {
    if (!phone) {
      setUnreadCount(0);
      setNotifications([]);
      setLoadError(false);
      return;
    }
    void refreshUnreadCount(phone);
  }, [phone, refreshUnreadCount]);

  // OTP-off: Realtime filters on user_phone but RLS uses auth_user_phone() (NULL),
  // so events often never arrive. Poll is the source of truth for the badge.
  useEffect(() => {
    if (!phone) return;
    const onTick = () => {
      void refreshUnreadCount(phone);
      if (openRef.current) void loadTray(phone);
    };
    const t = window.setInterval(onTick, NOTIFICATION_BELL_POLL_MS);
    return () => window.clearInterval(t);
  }, [phone, refreshUnreadCount, loadTray]);

  useUserNotificationsRealtime(phone, () => {
    if (!phone) return;
    void refreshUnreadCount(phone);
    if (openRef.current) void loadTray(phone);
  });

  const closeUi = useCallback(() => {
    setClearConfirmOpen(false);
    setOpen(false);
  }, []);
  const requestClose = useOverlayBack(open, closeUi, "aaspaasNotifBell");

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      requestClose();
      return;
    }
    setOpen(true);
    setClearConfirmOpen(false);
    const userPhone = getUserPhone();
    if (userPhone) setPhone(userPhone);
    const activePhone = userPhone ?? phone;
    if (!activePhone) return;
    void loadTray(activePhone);
    void markInformationalRead(activePhone);
  };

  const handleNotificationTap = async (n: UserNotification) => {
    if (!phone) return;
    const now = new Date().toISOString();
    if (!n.is_read) {
      await ensureUserDeviceLink(phone);
      const { error } = await supabase.rpc("mark_user_notification_read", {
        p_user_phone: phone,
        p_device_id: getDeviceId(),
        p_notification_id: n.id,
      });
      if (error) {
        console.error("NotificationBell mark read", error);
        captureError(error, {
          notificationSurface: "bell",
          operation: "mark_user_notification_read",
        });
      } else {
        setNotifications((prev) =>
          prev.map((row) =>
            row.id === n.id ? { ...row, is_read: true, read_at: now } : row,
          ),
        );
        void refreshUnreadCount(phone);
      }
    }
    requestClose();
    navigateFromNotification(navigate, n.route, n.route_params);
  };

  const pendingOrderCount = Math.max(0, extraCount);
  const vendorDualBadges = pendingOrderCount > 0;

  const isNav = layout === "nav";

  return (
    <>
      <button
        type="button"
        data-testid={isNav ? "desktop-nav-notifications" : "notification-bell-btn"}
        onClick={() => handleOpenChange(true)}
        className={cn(
          isNav
            ? "relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium active:opacity-90"
            : "relative h-10 w-10 shrink-0 grid place-items-center rounded-full border border-border bg-card text-foreground active:opacity-90",
          className,
          !isNav && "lg:hidden",
        )}
        aria-label={s.notif_bell_aria_label}
        data-unread-count={unreadCount}
      >
        {isNav ? (
          <>
            <span className="relative shrink-0">
              <Bell className="h-5 w-5" />
              {vendorDualBadges ? (
                <>
                  {unreadCount > 0 && (
                    <span
                      className="absolute -top-1 -left-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-xs font-bold tabular-nums"
                      aria-hidden
                      data-testid="notification-bell-badge"
                    >
                      {formatBadgeCount(unreadCount)}
                    </span>
                  )}
                  {pendingOrderCount > 0 && (
                    <span
                      className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-amber-500 text-amber-950 text-xs font-bold tabular-nums"
                      aria-hidden
                    >
                      {formatBadgeCount(pendingOrderCount)}
                    </span>
                  )}
                </>
              ) : (
                unreadCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-xs font-bold tabular-nums"
                    aria-hidden
                    data-testid="notification-bell-badge"
                  >
                    {formatBadgeCount(unreadCount)}
                  </span>
                )
              )}
            </span>
            <span className="min-w-0 flex-1 text-left">{navLabel ?? s.notif_bell_title}</span>
          </>
        ) : (
          <>
            <Bell className="h-5 w-5" />
            {vendorDualBadges ? (
              <>
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-1 -left-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-xs font-bold tabular-nums"
                    aria-hidden
                    data-testid="notification-bell-badge"
                  >
                    {formatBadgeCount(unreadCount)}
                  </span>
                )}
                {pendingOrderCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-amber-500 text-amber-950 text-xs font-bold tabular-nums"
                    aria-hidden
                  >
                    {formatBadgeCount(pendingOrderCount)}
                  </span>
                )}
              </>
            ) : (
              unreadCount > 0 && (
                <span
                  className="absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center rounded-full bg-brand text-[#0b1f14] text-xs font-bold tabular-nums"
                  aria-hidden
                  data-testid="notification-bell-badge"
                >
                  {formatBadgeCount(unreadCount)}
                </span>
              )
            )}
          </>
        )}
      </button>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl border-t border-border bg-background max-h-[85vh] flex flex-col p-0 [&>button]:min-h-[44px] [&>button]:min-w-[44px] [&>button]:grid [&>button]:place-items-center"
        >
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border text-left shrink-0">
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle className="text-foreground">{s.notif_bell_title}</SheetTitle>
              {!loadError && (unreadCount > 0 || notifications.length > 0) && (
                <div className="flex items-center gap-2 shrink-0">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleMarkAllRead()}
                      className="min-h-[44px] px-2 text-xs font-medium text-brand"
                    >
                      {s.notifications_mark_all_read}
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setClearConfirmOpen(true)}
                      className="min-h-[44px] px-2 text-xs font-medium text-muted-foreground"
                    >
                      {s.notifications_clear_all}
                    </button>
                  )}
                </div>
              )}
            </div>
          </SheetHeader>

          {clearConfirmOpen && (
            <div
              className="mx-4 mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2"
              data-testid="notif-clear-all-confirm"
            >
              <p className="text-xs text-destructive font-semibold text-center">
                {s.notifications_clear_all_confirm_q}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="min-h-[44px] rounded-lg bg-destructive text-white text-xs font-semibold"
                  onClick={() => {
                    setClearConfirmOpen(false);
                    if (phone) void clearAll(phone);
                  }}
                >
                  {s.notifications_clear_all_confirm_yes}
                </button>
                <button
                  type="button"
                  className="min-h-[44px] rounded-lg border border-border text-xs font-semibold"
                  onClick={() => setClearConfirmOpen(false)}
                >
                  {s.cancel}
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {loading && notifications.length === 0 && !loadError ? (
              <p className="text-sm text-muted-foreground text-center py-8">{s.notif_bell_loading}</p>
            ) : loadError ? (
              <div
                className="flex flex-col items-center justify-center py-12 text-center gap-3"
                data-testid="notification-bell-load-error"
              >
                <div className="h-16 w-16 rounded-full bg-muted border border-border grid place-items-center">
                  <Bell className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{s.notif_bell_load_error}</p>
                <button
                  type="button"
                  data-testid="notification-bell-retry"
                  className="min-h-[44px] rounded-xl border border-border px-4 text-sm font-semibold"
                  onClick={() => {
                    const p = getUserPhone() ?? phone;
                    if (p) void loadTray(p);
                  }}
                >
                  {s.network_retry_btn}
                </button>
              </div>
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
                    <div className="flex-1 min-w-0 px-3 py-3">
                      <button
                        type="button"
                        onClick={() => void handleNotificationTap(n)}
                        className="w-full text-left active:opacity-90"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-foreground leading-snug min-w-0 flex-1">
                            {n.title}
                          </p>
                          <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                            {formatTimeAgo(n.created_at)}
                          </span>
                        </div>
                      </button>
                      {n.body ? (
                        <>
                          <p
                            className={cn(
                              "text-xs text-muted-foreground mt-1 leading-relaxed",
                              !expandedIds.has(n.id) && "line-clamp-2",
                            )}
                          >
                            {n.body}
                          </p>
                          {notificationBodyNeedsExpand(n.body) && (
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(n.id)) next.delete(n.id);
                                  else next.add(n.id);
                                  return next;
                                });
                              }}
                              className="mt-1 text-xs font-semibold text-brand"
                            >
                              {expandedIds.has(n.id) ? s.notif_show_less : s.notif_read_more}
                            </button>
                          )}
                        </>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-label={s.notif_bell_dismiss_aria}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismissNotification(n);
                      }}
                      className="shrink-0 min-w-[44px] min-h-[44px] grid place-items-center text-muted-foreground hover:text-foreground border-l border-border active:opacity-70"
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
                requestClose();
                navigate("/vendor");
              }}
              className="shrink-0 mx-4 mb-4 mt-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-left text-xs text-foreground leading-relaxed active:opacity-90"
            >
              {s.notifications_pending_orders_note.replace("{count}", String(pendingOrderCount))}
            </button>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
