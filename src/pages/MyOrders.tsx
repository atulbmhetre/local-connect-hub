import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { RatingSheet } from "@/components/RatingSheet";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

type RowWithShop = OrderRequestRow & {
  vendors: { shop_name: string; service_mode: string | null } | null;
};

const MS_24H = 24 * 60 * 60 * 1000;

function orderCreatedWithinLast24h(created_at: string): boolean {
  const t = new Date(created_at).getTime();
  return Number.isFinite(t) && Date.now() - t < MS_24H;
}

const userStatusLabel = (r: Pick<OrderRequestRow, "status" | "created_at">) => {
  if (r.status === "sent") return "📤 Sent";
  if (r.status === "seen") {
    return orderCreatedWithinLast24h(r.created_at)
      ? "👀 Vendor saw your order"
      : "⚠️ No response yet";
  }
  if (r.status === "fulfilled") return "✅ Vendor fulfilled your order";
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

function extractDeliverySlot(message: string): string | null {
  const match = message.match(/\[Deliver: ([^\]]+)\]/);
  return match ? match[1] : null;
}

function stripDeliverySlot(message: string): string {
  return message.replace(/\s*\[Deliver:[^\]]+\]/g, "").trim();
}

const MyOrders = () => {
  const navigate = useNavigate();
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
  const mounted = useRef(true);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let listQuery = supabase
      .from("requests")
      .select(
        "id, device_id, vendor_id, message, status, created_at, user_phone, appointment_time, appointment_status, vendors(shop_name, service_mode)",
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
      toast.error("Could not update", { description: error.message });
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
      toast.error("Could not cancel", { description: error.message });
      return;
    }
    toast.success("Booking cancelled.");
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleFulfilledDismiss = (r: RowWithShop) => {
    setPendingDismissId(r.id);
    setRatingVendor({
      vendorId: r.vendor_id,
      shopName: r.vendors?.shop_name ?? "Shop",
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
          aria-label="Back to home"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Aaspaas Pro</p>
          <h1 className="font-display text-2xl font-bold mt-1">My orders</h1>
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            No active orders.
            <br />
            Search for a vendor to send your first order!
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="w-full rounded-xl bg-[#22C55E] text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
          >
            Find Vendors →
          </button>
        </div>
      ) : (
        <ul className="space-y-3 pb-4">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-2xl border border-[#2a2a2a] bg-[#141414] p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-foreground truncate min-w-0">
                  {r.vendors?.shop_name ?? "Shop"}
                </p>
                <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                  {formatTimeAgo(r.created_at)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{userStatusLabel(r)}</p>
              <p className="text-sm text-foreground/90 leading-snug whitespace-pre-wrap break-words">
                {stripDeliverySlot(stripLocationTag(r.message))}
              </p>
              {(() => {
                const slot = extractDeliverySlot((r as any).message ?? "");
                if (!slot) return null;
                return (
                  <div className="mt-1 rounded-lg border border-[#22C55E]/30 bg-[#22C55E]/5 px-3 py-2 text-[11px]">
                    🕐 <span className="text-[#22C55E] font-semibold">{slot}</span>
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
                    ? "🏠 They'll come to you"
                    : isShop
                      ? "🏪 You'll visit their shop"
                      : "📞 Location TBD";
                  return (
                    <div className={`mt-2 rounded-lg border px-3 py-2 text-[11px] space-y-0.5 ${borderColor}`}>
                      <div className={`font-semibold ${labelColor}`}>{locationLabel}</div>
                      <div>
                        📅 Around{" "}
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
                          {(r as any).appointment_status === "confirmed" && "· ✅ Vendor confirmed"}
                          {(r as any).appointment_status === "declined" && "· ❌ Vendor declined"}
                          {(r as any).appointment_status === "cancelled" && "· ❌ Vendor cancelled"}
                          {(r as any).appointment_status === "pending" && "· ⏳ Awaiting confirmation"}
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
                        🗑 Dismiss
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
                        Cancel Booking
                      </button>
                    );
                  }

                  if (!calledVendor[r.id]) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400 text-center">
                          ⚠️ Same-day changes require a call to the vendor first
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            window.open(`tel:${r.user_phone}`, "_self");
                            setTimeout(() => setCalledVendor((p) => ({ ...p, [r.id]: true })), 3000);
                          }}
                          className="w-full rounded-lg border border-[#22C55E]/40 text-[#22C55E] text-xs font-semibold py-2"
                        >
                          📞 Connect via AI-Bridge to Cancel
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      <p className="text-[11px] text-gray-400 text-center">
                        ✅ Call done — you may now cancel your booking
                      </p>
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        Cancel Booking
                      </button>
                    </div>
                  );
                })()}

              {showCancelConfirm[r.id] && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-xs text-destructive font-semibold text-center">
                    Are you sure you want to cancel?
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void cancelAppointment(r.id)}
                      className="rounded-lg bg-destructive text-white text-xs font-semibold py-2"
                    >
                      Yes, Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                      className="rounded-lg border border-border text-xs font-semibold py-2"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {r.status === "fulfilled" ? (
                  <button
                    type="button"
                    disabled={markingId === r.id}
                    onClick={() => handleFulfilledDismiss(r)}
                    className="w-full rounded-xl bg-[#22C55E] text-[#0b1f14] text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50 shadow-[0_0_14px_rgba(34,197,94,0.35)]"
                  >
                    {markingId === r.id ? "Saving…" : "✅ Delivered! Tap to dismiss"}
                  </button>
                ) : null}
                {!(r as any).appointment_time &&
                  (canShowRemoveOrder(r) ? (
                    !showOrderCancelConfirm[r.id] ? (
                      <button
                        type="button"
                        disabled={markingId === r.id}
                        onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: true }))}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                      >
                        Cancel Order
                      </button>
                    ) : (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                        <p className="text-xs text-destructive font-semibold text-center">
                          Are you sure you want to cancel this order?
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={markingId === r.id}
                            onClick={() => void handleRemoveOrder(r.id)}
                            className="rounded-lg bg-destructive text-white text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            Yes, Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                            className="rounded-lg border border-border text-xs font-semibold py-2"
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    )
                  ) : r.status === "seen" && orderCreatedWithinLast24h(r.created_at) ? (
                    <p className="text-[11px] text-muted-foreground text-center px-1">
                      🔒 Cannot cancel — vendor is already on it
                    </p>
                  ) : null)}
              </div>
            </li>
          ))}
        </ul>
      )}

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
    </AppShell>
  );
};

export default MyOrders;
