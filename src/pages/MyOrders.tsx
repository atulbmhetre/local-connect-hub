import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { supabase, invokeNotifyVendor, distanceMeters, fetchAiBridgeBrief } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { RatingSheet } from "@/components/RatingSheet";
import { ArrowLeft, Loader2, Pencil, PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const MAX_LEN = 200;
const MS_10M = 10 * 60 * 1000;
const STOPPED_RADIUS_M = 200;

type RowWithShop = OrderRequestRow & {
  vendors: { shop_name: string; service_mode: string | null; phone: string | null } | null;
};

type VendorLocationPoint = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

type VendorLiveLocation = {
  latitude: number;
  longitude: number;
  lastUpdated: string;
};

function telHref(phone: string) {
  return `tel:${phone.replace(/[\s-]/g, "").trim()}`;
}

function formatVendorDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} mtr away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

function maxSpreadMeters(points: Pick<VendorLocationPoint, "latitude" | "longitude">[]): number {
  if (points.length < 2) return 0;
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(
        max,
        distanceMeters(
          { lat: points[i].latitude, lng: points[i].longitude },
          { lat: points[j].latitude, lng: points[j].longitude },
        ),
      );
    }
  }
  return max;
}

function computeVendorStopped(history: VendorLocationPoint[]): boolean {
  const cutoff = Date.now() - MS_10M;
  const recent = history.filter((p) => p.timestamp >= cutoff);
  if (recent.length < 2) return false;

  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const movedSincePrev = distanceMeters(
    { lat: prev.latitude, lng: prev.longitude },
    { lat: last.latitude, lng: last.longitude },
  );
  if (movedSincePrev > STOPPED_RADIUS_M) return false;

  return maxSpreadMeters(recent) <= STOPPED_RADIUS_M;
}

const MS_24H = 24 * 60 * 60 * 1000;

function orderCreatedWithinLast24h(created_at: string): boolean {
  const t = new Date(created_at).getTime();
  return Number.isFinite(t) && Date.now() - t < MS_24H;
}

const userStatusLabel = (
  r: Pick<OrderRequestRow, "status" | "created_at"> & {
    vendors?: { service_mode: string | null } | null;
  },
  s: ReturnType<typeof useLanguage>["s"],
) => {
  if (r.status === "accepted" && r.vendors?.service_mode === "help") {
    return s.status_accepted;
  }
  if (r.status === "sent") return s.myOrders_statusSent;
  if (r.status === "seen") {
    return orderCreatedWithinLast24h(r.created_at)
      ? s.myOrders_statusSeen
      : s.myOrders_statusNoResponse;
  }
  if (r.status === "fulfilled") return s.myOrders_statusFulfilled;
  if (r.status === "cancelled") return s.myOrders_cancelledByVendor;
  return r.status;
};

function canShowRemoveOrder(r: Pick<OrderRequestRow, "status" | "created_at">): boolean {
  if (r.status === "sent") return true;
  if (r.status === "seen") return !orderCreatedWithinLast24h(r.created_at);
  return false;
}

function stripLocationTag(message: string): string {
  return message
    .replace(/\s*\[Come to my place\]/g, "")
    .replace(/\s*\[I'll visit your shop\]/g, "")
    .replace(/\s*\[Location TBD\]/g, "")
    .trim();
}

function extractLocationTag(message: string): string {
  const m = message.match(/\s*(\[Come to my place\]|\[I'll visit your shop\]|\[Location TBD\])/);
  return m ? m[1] : "";
}

function buildMessageWithTags(base: string, original: string): string {
  const loc = extractLocationTag(original);
  const suffix = loc ? ` ${loc}` : "";
  return base.slice(0, MAX_LEN) + suffix;
}

function deliverySlotLabel(
  slot: string | null | undefined,
  labels: Record<string, string>,
): string | null {
  if (!slot?.trim()) return null;
  return labels[slot.trim().toLowerCase()] ?? slot;
}

const MyOrders = () => {
  const navigate = useNavigate();
  const { s } = useLanguage();
  const slotLabels = useMemo(
    () => ({
      asap: s.parchi_slotAsap,
      morning: s.parchi_slotMorning,
      afternoon: s.parchi_slotAfternoon,
      evening: s.parchi_slotEvening,
      tomorrow: s.parchi_slotTomorrow,
    }),
    [s],
  );
  const [rows, setRows] = useState<RowWithShop[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [ratingSheetOpen, setRatingSheetOpen] = useState(false);
  const [ratingVendor, setRatingVendor] = useState<{
    vendorId: string;
    shopName: string;
    serviceMode: string;
  } | null>(null);
  const [pendingDismissId, setPendingDismissId] = useState<string | null>(null);
  const [calledVendor, setCalledVendor] = useState<Record<string, boolean>>({});
  const [showCancelConfirm, setShowCancelConfirm] = useState<Record<string, boolean>>({});
  const [showOrderCancelConfirm, setShowOrderCancelConfirm] = useState<Record<string, boolean>>({});
  const [editOrder, setEditOrder] = useState<RowWithShop | null>(null);
  const [editMessage, setEditMessage] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [vendorLiveById, setVendorLiveById] = useState<Record<string, VendorLiveLocation>>({});
  const [vendorStoppedByOrderId, setVendorStoppedByOrderId] = useState<Record<string, boolean>>({});
  const [locationTick, setLocationTick] = useState(0);
  const [helpCallVendor, setHelpCallVendor] = useState<{
    vendorId: string;
    shopName: string;
    phone: string;
    userNeed: string;
    distanceKm: number | null;
  } | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [aiSheetLoading, setAiSheetLoading] = useState(false);
  const [aiBriefText, setAiBriefText] = useState<string | null>(null);
  const [aiBriefFailed, setAiBriefFailed] = useState(false);
  const mounted = useRef(true);
  const vendorLocationHistoryRef = useRef<Map<string, VendorLocationPoint[]>>(new Map());

  const acceptedHelpOrders = useMemo(
    () =>
      rows.filter(
        (r) => r.status === "accepted" && r.vendors?.service_mode === "help",
      ),
    [rows],
  );

  const acceptedHelpVendorIds = useMemo(
    () => [...new Set(acceptedHelpOrders.map((r) => r.vendor_id))],
    [acceptedHelpOrders],
  );

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let listQuery = supabase
      .from("requests")
      .select(
        "id, device_id, vendor_id, message, status, created_at, user_phone, appointment_time, appointment_status, cancel_reason, delivery_slot, vendors(shop_name, service_mode, phone)",
      )
      .neq("status", "done")
      .order("created_at", { ascending: false });
    listQuery =
      userPhone != null ? listQuery.eq("user_phone", userPhone) : listQuery.eq("device_id", device_id);
    const { data, error } = await listQuery;
    if (!mounted.current) return;
    if (error) {
      setRows([]);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as unknown as RowWithShop[];
    setRows([...list]);
    if (!opts?.silent) setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const t = window.setInterval(() => void load({ silent: true }), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(t);
    };
  }, [load]);

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mounted.current) return;
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        /* best-effort */
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, [acceptedHelpVendorIds.join(",")]);

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;
    const t = window.setInterval(() => setLocationTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, [acceptedHelpVendorIds.join(",")]);

  const applyVendorLocationUpdate = useCallback(
    (
      vendorId: string,
      latitude: number | null,
      longitude: number | null,
      lastUpdated: string | null,
    ) => {
      if (
        latitude == null ||
        longitude == null ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        return;
      }

      const timestamp = lastUpdated ? new Date(lastUpdated).getTime() : Date.now();
      const history = [...(vendorLocationHistoryRef.current.get(vendorId) ?? [])];
      const prev = history[history.length - 1];
      const live: VendorLiveLocation = {
        latitude,
        longitude,
        lastUpdated: lastUpdated ?? new Date().toISOString(),
      };

      if (
        prev &&
        prev.latitude === latitude &&
        prev.longitude === longitude &&
        Math.abs(prev.timestamp - timestamp) < 5000
      ) {
        setVendorLiveById((prevLive) => ({ ...prevLive, [vendorId]: live }));
        const stopped = computeVendorStopped(history);
        setVendorStoppedByOrderId((prevStopped) => {
          const next = { ...prevStopped };
          for (const order of acceptedHelpOrders) {
            if (order.vendor_id === vendorId) {
              next[order.id] = stopped;
            }
          }
          return next;
        });
        return;
      }

      history.push({ latitude, longitude, timestamp });
      vendorLocationHistoryRef.current.set(vendorId, history);
      setVendorLiveById((prevLive) => ({ ...prevLive, [vendorId]: live }));

      const stopped = computeVendorStopped(history);
      setVendorStoppedByOrderId((prevStopped) => {
        const next = { ...prevStopped };
        for (const order of acceptedHelpOrders) {
          if (order.vendor_id === vendorId) {
            next[order.id] = stopped;
          }
        }
        return next;
      });
    },
    [acceptedHelpOrders],
  );

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;

    let cancelled = false;
    const activeIds = new Set(acceptedHelpVendorIds);
    for (const key of vendorLocationHistoryRef.current.keys()) {
      if (!activeIds.has(key)) vendorLocationHistoryRef.current.delete(key);
    }

    void (async () => {
      const { data } = await supabase
        .from("vendors")
        .select("id, latitude, longitude, last_updated")
        .in("id", acceptedHelpVendorIds);
      if (cancelled || !data) return;
      for (const row of data) {
        applyVendorLocationUpdate(
          row.id,
          row.latitude,
          row.longitude,
          row.last_updated ?? null,
        );
      }
    })();

    const channel = supabase.channel("my-orders-vendor-locations");
    for (const vendorId of acceptedHelpVendorIds) {
      channel.on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "vendors",
          filter: `id=eq.${vendorId}`,
        },
        (payload) => {
          if (!mounted.current) return;
          const row = payload.new as {
            id: string;
            latitude: number | null;
            longitude: number | null;
            last_updated?: string | null;
          };
          applyVendorLocationUpdate(
            row.id,
            row.latitude,
            row.longitude,
            row.last_updated ?? null,
          );
        },
      );
    }
    channel.subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [acceptedHelpVendorIds.join(","), applyVendorLocationUpdate]);

  const closeAiSheet = useCallback((open: boolean) => {
    setAiSheetOpen(open);
    if (!open) {
      setAiSheetLoading(false);
      setAiBriefText(null);
      setAiBriefFailed(false);
      setHelpCallVendor(null);
    }
  }, []);

  const openHelpVendorCall = useCallback(
    async (order: RowWithShop) => {
      const phone = order.vendors?.phone?.trim();
      if (!phone) return;

      const live = vendorLiveById[order.vendor_id];
      const distM =
        live && userCoords
          ? distanceMeters(
              { lat: userCoords.lat, lng: userCoords.lng },
              { lat: live.latitude, lng: live.longitude },
            )
          : null;

      setHelpCallVendor({
        vendorId: order.vendor_id,
        shopName: order.vendors?.shop_name ?? s.myOrders_shopFallback,
        phone,
        userNeed: stripLocationTag(order.message),
        distanceKm: distM != null ? distM / 1000 : null,
      });
      setAiSheetOpen(true);
      setAiSheetLoading(true);
      setAiBriefFailed(false);
      setAiBriefText(null);

      const result = await fetchAiBridgeBrief({
        vendor_name: order.vendors?.shop_name ?? s.myOrders_shopFallback,
        shop_name: order.vendors?.shop_name ?? s.myOrders_shopFallback,
        category: "help",
        distance_km: distM != null ? distM / 1000 : null,
        user_need: stripLocationTag(order.message) || "help",
      });

      if (!mounted.current) return;
      setAiSheetLoading(false);
      if (result.ok) {
        setAiBriefText(result.brief);
        setAiBriefFailed(false);
      } else {
        setAiBriefText(null);
        setAiBriefFailed(true);
      }
    },
    [s.myOrders_shopFallback, userCoords, vendorLiveById],
  );

  useEffect(() => {
    const userPhone = getUserPhone();
    const device_id = getDeviceId();

    const channel = supabase
      .channel("my-orders-realtime")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "requests",
          filter: userPhone
            ? `user_phone=eq.${userPhone}`
            : `device_id=eq.${device_id}`,
        },
        (payload) => {
          if (!mounted.current) return;
          setRows((prev) =>
            prev.map((r) =>
              r.id === payload.new.id ? { ...r, ...payload.new } : r,
            ),
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const markDone = async (id: string) => {
    setMarkingId(id);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let updateQuery = supabase.from("requests").update({ status: "done" }).eq("id", id);
    updateQuery =
      userPhone != null ? updateQuery.eq("user_phone", userPhone) : updateQuery.eq("device_id", device_id);
    const { error } = await updateQuery;
    setMarkingId(null);
    if (error) {
      toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleRemoveOrder = (id: string) => {
    void markDone(id);
  };

  const cancelAppointment = async (id: string) => {
    const { error } = await supabase
      .from("requests")
      .update({ status: "done", appointment_status: "cancelled" })
      .eq("id", id);
    if (error) {
      toast.error(s.myOrders_errCouldNotCancel, { description: error.message });
      return;
    }
    toast.success(s.myOrders_bookingCancelled);
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const openEditSheet = (r: RowWithShop) => {
    setEditOrder(r);
    setEditMessage(stripLocationTag(r.message));
  };

  const closeEditSheet = () => {
    setEditOrder(null);
    setEditMessage("");
  };

  const saveOrderEdit = async () => {
    if (!editOrder) return;
    const trimmed = editMessage.trim();
    if (!trimmed) return;
    const originalStripped = stripLocationTag(editOrder.message);
    if (trimmed === originalStripped) return;

    const newMessage = buildMessageWithTags(trimmed, editOrder.message);
    const wasSeen = editOrder.status === "seen";

    setSavingEdit(true);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let updateQuery = supabase.from("requests").update({ message: newMessage }).eq("id", editOrder.id);
    updateQuery =
      userPhone != null ? updateQuery.eq("user_phone", userPhone) : updateQuery.eq("device_id", device_id);
    const { error } = await updateQuery;
    setSavingEdit(false);

    if (error) {
      toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
      return;
    }

    setRows((prev) =>
      prev.map((r) => (r.id === editOrder.id ? { ...r, message: newMessage } : r)),
    );

    if (wasSeen) {
      void invokeNotifyVendor({
        vendor_id: editOrder.vendor_id,
        message: stripLocationTag(newMessage),
        notification_title: "Order updated by user",
      });
    }

    toast.success(s.orderUpdated);
    closeEditSheet();
  };

  const handleFulfilledDismiss = (r: RowWithShop) => {
    setPendingDismissId(r.id);
    setRatingVendor({
      vendorId: r.vendor_id,
      shopName: r.vendors?.shop_name ?? s.myOrders_shopFallback,
      serviceMode: r.vendors?.service_mode ?? "delivery",
    });
    setRatingSheetOpen(true);
  };

  return (
    <AppShell theme="dark">
      <header className="flex items-start gap-3 mb-6">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-card border border-border"
          aria-label={s.myOrders_backToHome}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">{s.myOrders_appName}</p>
          <h1 className="font-display text-2xl font-bold mt-1">{s.myOrders_heading}</h1>
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {s.myOrders_noOrders}
            <br />
            {s.myOrders_noOrdersHint}
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="w-full rounded-xl bg-[#22C55E] text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
          >
            {s.myOrders_findVendors}
          </button>
        </div>
      ) : (
        <ul className="space-y-3 pb-4">
          {rows.map((r) => (
            <li
              key={r.id}
              className={cn(
                "rounded-2xl border p-4 space-y-2",
                r.status === "cancelled"
                  ? "border-destructive/50 bg-destructive/5"
                  : "border-[#2a2a2a] bg-[#141414]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-foreground truncate min-w-0">
                  {r.vendors?.shop_name ?? s.myOrders_shopFallback}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  {(r.status === "sent" || r.status === "seen") && (
                    <button
                      type="button"
                      onClick={() => openEditSheet(r)}
                      className="h-8 w-8 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
                      aria-label={s.editOrder}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatTimeAgo(r.created_at)}
                  </span>
                </div>
              </div>
              {r.status === "cancelled" ? (
                <span className="inline-flex rounded-full bg-destructive/15 text-destructive text-[11px] font-semibold px-2.5 py-1 border border-destructive/40">
                  {s.myOrders_cancelledByVendor}
                </span>
              ) : r.status === "accepted" && r.vendors?.service_mode === "help" ? (
                <span className="inline-flex rounded-full bg-[#22C55E]/15 text-[#22C55E] text-[11px] font-semibold px-2.5 py-1 border border-[#22C55E]/40">
                  {s.status_accepted}
                </span>
              ) : (
                <p className="text-xs text-muted-foreground">{userStatusLabel(r, s)}</p>
              )}
              <p className="text-sm text-foreground/90 leading-snug whitespace-pre-wrap break-words">
                {stripLocationTag(r.message)}
              </p>
              {r.status === "accepted" &&
                r.vendors?.service_mode === "help" &&
                (() => {
                  const live = vendorLiveById[r.vendor_id];
                  const distM =
                    live && userCoords
                      ? distanceMeters(
                          { lat: userCoords.lat, lng: userCoords.lng },
                          { lat: live.latitude, lng: live.longitude },
                        )
                      : null;
                  void locationTick;
                  return (
                    <>
                      {live && distM != null && (
                        <p className="text-[11px] text-[#22C55E]">
                          📍 Vendor is {formatVendorDistance(distM)} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {!live && (
                        <p className="text-[11px] text-muted-foreground">📍 {s.vendor_distance}</p>
                      )}
                      {live && distM == null && (
                        <p className="text-[11px] text-[#22C55E]">
                          📍 {s.vendor_distance} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {vendorStoppedByOrderId[r.id] && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                          <p className="text-[11px] text-amber-400 text-center leading-snug">
                            {s.vendor_stopped_warning}
                          </p>
                          {r.vendors?.phone && (
                            <button
                              type="button"
                              onClick={() => void openHelpVendorCall(r)}
                              className="w-full rounded-lg border border-[#22C55E]/40 text-[#22C55E] text-xs font-semibold py-2"
                            >
                              {s.radar_connect_ai}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              {r.status === "cancelled" && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {r.cancel_reason?.trim() || s.myOrders_vendorCancelledDefault}
                  </p>
                </div>
              )}
              {(() => {
                const slot = deliverySlotLabel(r.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="mt-1 rounded-lg border border-[#22C55E]/30 bg-[#22C55E]/5 px-3 py-2 text-[11px]">
                    {s.myOrders_deliverySlotPrefix}<span className="text-[#22C55E] font-semibold">{slot}</span>
                  </div>
                );
              })()}
              {(r as any).appointment_time &&
                (() => {
                  const msg = (r as any).message ?? "";
                  const isHome = msg.includes("[Come to my place]");
                  const isShop = msg.includes("[I'll visit your shop]");
                  const borderColor = isHome
                    ? "border-blue-500/30 bg-blue-500/5"
                    : isShop
                      ? "border-purple-500/30 bg-purple-500/5"
                      : "border-gray-500/30 bg-gray-500/5";
                  const labelColor = isHome
                    ? "text-blue-400"
                    : isShop
                      ? "text-purple-400"
                      : "text-gray-400";
                  const timeColor = isHome
                    ? "text-blue-400"
                    : isShop
                      ? "text-purple-400"
                      : "text-gray-400";
                  const locationLabel = isHome
                    ? s.myOrders_locationComeToYou
                    : isShop
                      ? s.myOrders_locationVisitShop
                      : s.myOrders_locationTbd;
                  return (
                    <div className={`mt-2 rounded-lg border px-3 py-2 text-[11px] space-y-0.5 ${borderColor}`}>
                      <div className={`font-semibold ${labelColor}`}>{locationLabel}</div>
                      <div>
                        {s.myOrders_apptAround}
                        <span className={`font-semibold ${timeColor}`}>
                          {new Date((r as any).appointment_time).toLocaleString("en-IN", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {(r as any).appointment_status === "confirmed" && s.myOrders_apptConfirmed}
                          {(r as any).appointment_status === "declined" && s.myOrders_apptDeclined}
                          {(r as any).appointment_status === "cancelled" && s.myOrders_apptCancelled}
                          {(r as any).appointment_status === "pending" && s.myOrders_apptAwaiting}
                        </span>
                      </div>
                    </div>
                  );
                })()}

              {(r as any).appointment_time &&
                r.status !== "fulfilled" &&
                r.status !== "done" &&
                (() => {
                  if (
                    (r as any).appointment_status === "declined" ||
                    (r as any).appointment_status === "cancelled"
                  ) {
                    return (
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_dismiss}
                      </button>
                    );
                  }

                  const appointmentDate = new Date((r as any).appointment_time);
                  const today = new Date();
                  const isSameDay = appointmentDate.toDateString() === today.toDateString();
                  const isPast = appointmentDate < today;

                  if (isPast) return null;

                  if (!isSameDay) {
                    return (
                      <button
                        type="button"
                        onClick={() => setShowCancelConfirm((p) => ({ ...p, [r.id]: true }))}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    );
                  }

                  if (!calledVendor[r.id]) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400 text-center">
                          {s.myOrders_sameDayWarning}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            window.open(`tel:${r.user_phone}`, "_self");
                            setTimeout(() => setCalledVendor((p) => ({ ...p, [r.id]: true })), 3000);
                          }}
                          className="w-full rounded-lg border border-[#22C55E]/40 text-[#22C55E] text-xs font-semibold py-2"
                        >
                          {s.myOrders_callThenCancel}
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      <p className="text-[11px] text-gray-400 text-center">
                        {s.myOrders_callDone}
                      </p>
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    </div>
                  );
                })()}

              {showCancelConfirm[r.id] && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-xs text-destructive font-semibold text-center">
                    {s.myOrders_confirmCancelQ}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void cancelAppointment(r.id)}
                      className="rounded-lg bg-destructive text-white text-xs font-semibold py-2"
                    >
                      {s.myOrders_yesCancel}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                      className="rounded-lg border border-border text-xs font-semibold py-2"
                    >
                      {s.myOrders_keepIt}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {r.status === "cancelled" ? (
                  <button
                    type="button"
                    disabled={markingId === r.id}
                    onClick={() => void markDone(r.id)}
                    className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                  >
                    {markingId === r.id ? s.myOrders_saving : s.myOrders_dismiss}
                  </button>
                ) : null}
                {r.status === "fulfilled" ? (
                  <button
                    type="button"
                    disabled={markingId === r.id}
                    onClick={() => handleFulfilledDismiss(r)}
                    className="w-full rounded-xl bg-[#22C55E] text-[#0b1f14] text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50 shadow-[0_0_14px_rgba(34,197,94,0.35)]"
                  >
                    {markingId === r.id ? s.myOrders_saving : s.myOrders_delivered}
                  </button>
                ) : null}
                {r.status !== "cancelled" &&
                  !(r as any).appointment_time &&
                  (canShowRemoveOrder(r) ? (
                    !showOrderCancelConfirm[r.id] ? (
                      <button
                        type="button"
                        disabled={markingId === r.id}
                        onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: true }))}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                      >
                        {s.myOrders_cancelOrder}
                      </button>
                    ) : (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                        <p className="text-xs text-destructive font-semibold text-center">
                          {s.myOrders_confirmCancelOrderQ}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={markingId === r.id}
                            onClick={() => void handleRemoveOrder(r.id)}
                            className="rounded-lg bg-destructive text-white text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {s.myOrders_yesCancel}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                            className="rounded-lg border border-border text-xs font-semibold py-2"
                          >
                            {s.myOrders_keepIt}
                          </button>
                        </div>
                      </div>
                    )
                  ) : r.status === "seen" && orderCreatedWithinLast24h(r.created_at) ? (
                    <p className="text-[11px] text-muted-foreground text-center px-1">
                      {s.myOrders_cannotCancel}
                    </p>
                  ) : null)}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={editOrder != null} onOpenChange={(open) => !open && closeEditSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>{s.editOrder}</SheetTitle>
          </SheetHeader>
          {editOrder?.status === "seen" && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
              {s.vendorSeenWarning}
            </p>
          )}
          <textarea
            value={editMessage}
            onChange={(e) => setEditMessage(e.target.value.slice(0, MAX_LEN))}
            rows={4}
            className="mt-3 w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="Your order message"
          />
          <p className="text-[10px] text-muted-foreground text-right mt-1">
            {editMessage.length}/{MAX_LEN}
          </p>
          <button
            type="button"
            disabled={
              savingEdit ||
              !editMessage.trim() ||
              !editOrder ||
              editMessage.trim() === stripLocationTag(editOrder.message)
            }
            onClick={() => void saveOrderEdit()}
            className={cn(
              "mt-4 w-full rounded-xl bg-[#22C55E] text-[#0b1f14] py-3 font-semibold disabled:opacity-50",
            )}
          >
            {savingEdit ? s.myOrders_saving : s.saveChanges}
          </button>
        </SheetContent>
      </Sheet>

      <RatingSheet
        isOpen={ratingSheetOpen}
        shopName={ratingVendor?.shopName ?? ""}
        serviceMode={ratingVendor?.serviceMode ?? "delivery"}
        vendorId={ratingVendor?.vendorId ?? ""}
        onDismiss={async () => {
          setRatingSheetOpen(false);
          const id = pendingDismissId;
          if (id) await markDone(id);
          setPendingDismissId(null);
          setRatingVendor(null);
        }}
      />

      <Sheet open={aiSheetOpen} onOpenChange={closeAiSheet}>
        <SheetContent
          side="bottom"
          className="bg-[#0a0a0a] border-t border-[#1f1f1f] text-white rounded-t-2xl max-h-[85vh] overflow-y-auto"
        >
          <SheetHeader className="text-left space-y-1 pr-8">
            <SheetTitle className="text-white font-display">{s.aiBridge}</SheetTitle>
            <SheetDescription className="text-gray-400">
              {aiSheetLoading
                ? s.briefingVendor
                : aiBriefFailed
                  ? s.aiBriefUnavailable
                  : s.radar_your_brief}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {aiSheetLoading && (
              <div className="flex items-center gap-3 py-6 text-gray-300">
                <Loader2 className="h-6 w-6 animate-spin text-[#22C55E] shrink-0" />
                <p className="text-sm">{s.briefingVendor}</p>
              </div>
            )}

            {!aiSheetLoading && aiBriefFailed && (
              <p className="text-sm text-amber-200/90 leading-relaxed">{s.aiBriefUnavailable}</p>
            )}

            {!aiSheetLoading && !aiBriefFailed && aiBriefText && (
              <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{aiBriefText}</p>
            )}

            {!aiSheetLoading && helpCallVendor && (
              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  className="w-full rounded-xl bg-[#22C55E] text-[#0a0a0a] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                  onClick={() => window.open(telHref(helpCallVendor.phone), "_self")}
                >
                  <PhoneCall className="h-4 w-4" />
                  {s.callNow}
                </button>
                <button
                  type="button"
                  className="w-full rounded-xl border border-[#333] bg-transparent text-gray-300 py-3 font-semibold active:scale-[0.99] transition-transform"
                  onClick={() => closeAiSheet(false)}
                >
                  {s.radar_cancel}
                </button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
};

export default MyOrders;
