import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatTimeAgo, buildRequestsActiveWindowOrFilter, type OrderRequestRow } from "@/lib/orders";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Props = {
  vendorId: string;
  onUnreadCount?: (n: number) => void;
};

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

export function IncomingOrdersSection({ vendorId, onUnreadCount }: Props) {
  const [rows, setRows] = useState<OrderRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [calledUser, setCalledUser] = useState<Record<string, boolean>>({});
  const mounted = useRef(true);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      const windowOr = buildRequestsActiveWindowOrFilter("vendor");
      const { data, error } = await supabase
        .from("requests")
        .select("id, device_id, vendor_id, message, status, created_at, user_phone, delivery_address, appointment_time, appointment_status")
        .eq("vendor_id", vendorId)
        .or(windowOr)
        .order("created_at", { ascending: false })
        .limit(20);
      if (!mounted.current) return;
      if (error) {
        setRows([]);
        onUnreadCount?.(0);
        setLoading(false);
        return;
      }
      const list = (data ?? []) as OrderRequestRow[];
      setRows(list);
      onUnreadCount?.(list.filter((r) => r.status === "sent").length);
      if (!opts?.silent) setLoading(false);

      const hadSent = list.some((r) => r.status === "sent");
      if (hadSent) {
        const { error: upErr } = await supabase
          .from("requests")
          .update({ status: "seen" })
          .eq("vendor_id", vendorId)
          .eq("status", "sent");
        if (upErr || !mounted.current) return;
        const { data: refreshed } = await supabase
          .from("requests")
          .select("id, device_id, vendor_id, message, status, created_at, user_phone, delivery_address, appointment_time, appointment_status")
          .eq("vendor_id", vendorId)
          .or(windowOr)
          .order("created_at", { ascending: false })
          .limit(20);
        if (!mounted.current) return;
        const refreshedList = ((refreshed ?? []) as OrderRequestRow[]) ?? list;
        setRows(refreshedList);
        onUnreadCount?.(refreshedList.filter((r) => r.status === "sent").length);
      }
    },
    [vendorId, onUnreadCount],
  );

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
    const channel = supabase
      .channel(`incoming-orders-${vendorId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "requests",
          filter: `vendor_id=eq.${vendorId}`,
        },
        () => {
          void load({ silent: true });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "requests",
          filter: `vendor_id=eq.${vendorId}`,
        },
        () => {
          void load({ silent: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [vendorId, load]);

  const markDone = async (id: string) => {
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ status: "fulfilled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
    if (error) {
      toast.error("Could not update order", { description: error.message });
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "fulfilled" } : r)));
  };

  const handleAppointmentAction = async (id: string, action: "confirmed" | "declined") => {
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ appointment_status: action })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
    if (error) {
      toast.error("Could not update appointment", { description: error.message });
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === id ? ({ ...r, appointment_status: action } as any) : r)),
    );
    toast.success(action === "confirmed" ? "✅ Appointment confirmed!" : "Appointment declined.");
  };

  const cancelAppointment = async (id: string) => {
    const { error } = await supabase
      .from("requests")
      .update({ appointment_status: "cancelled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    if (error) {
      toast.error("Could not cancel", { description: error.message });
      return;
    }
    toast.success("Booking cancelled.");
    setRows((prev) =>
      prev.map((r) => (r.id === id ? ({ ...r, appointment_status: "cancelled" } as any) : r)),
    );
  };

  const unread = rows.filter((r) => r.status === "sent").length;

  const badge = (status: string) => {
    if (status === "sent")
      return (
        <span className="rounded-full bg-[#22C55E]/20 text-[#22C55E] text-[10px] font-bold px-2 py-0.5 border border-[#22C55E]/40">
          New
        </span>
      );
    if (status === "seen")
      return (
        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
          Seen
        </span>
      );
    if (status === "fulfilled")
      return (
        <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-[#22C55E]/30 text-[#22C55E]">
          Done ✅
        </span>
      );
    return (
      <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-[#22C55E]/30 text-[#22C55E]">
        Done ✅
      </span>
    );
  };

  return (
    <div className="rounded-2xl bg-card border border-border shadow-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display font-bold text-base flex items-center gap-2">
          📋 Incoming Orders
          {unread > 0 && (
            <span className="rounded-full bg-[#22C55E] text-[#0b1f14] text-[11px] font-bold min-w-[1.25rem] h-5 px-1.5 grid place-items-center tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </h2>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No orders yet!</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-border bg-muted/30 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatTimeAgo(r.created_at)}
                </span>
                {badge(r.status)}
              </div>
              <p className="text-sm text-foreground leading-snug whitespace-pre-wrap break-words">
                {stripDeliverySlot(stripLocationTag(r.message))}
              </p>
              {(r as any).delivery_address && (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  📍 <span className="text-foreground font-medium">{(r as any).delivery_address}</span>
                </div>
              )}

              {(() => {
                const slot = extractDeliverySlot((r as any).message ?? "");
                if (!slot) return null;
                return (
                  <div className="rounded-lg border border-[#22C55E]/30 bg-[#22C55E]/5 px-3 py-2 text-[11px]">
                    🕐 <span className="text-[#22C55E] font-semibold">{slot}</span>
                  </div>
                );
              })()}

              {(r as any).appointment_time &&
                (() => {
                  const msg = (r as any).message ?? "";
                  const isHome = msg.includes("[Come to my place]");
                  const isShop = msg.includes("[I'll visit your shop]");
                  const colorClass = isHome
                    ? "border-blue-500/30 bg-blue-500/5 text-blue-400"
                    : isShop
                      ? "border-purple-500/30 bg-purple-500/5 text-purple-400"
                      : "border-gray-500/30 bg-gray-500/5 text-gray-400";
                  const locationLabel = isHome
                    ? "🏠 Coming to you"
                    : isShop
                      ? "🏪 Will visit your shop"
                      : "📞 Location TBD";
                  return (
                    <div className={`rounded-lg border px-3 py-2 text-[11px] space-y-0.5 ${colorClass}`}>
                      <div className="font-semibold">{locationLabel}</div>
                      <div>
                        📅 Around{" "}
                        <span className="font-semibold">
                          {new Date((r as any).appointment_time).toLocaleString("en-IN", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </div>
                  );
                })()}

              {(r as any).appointment_time &&
                (r as any).appointment_status === "pending" &&
                r.status !== "fulfilled" && (
                <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={markingId === r.id}
                      onClick={() => void handleAppointmentAction(r.id, "confirmed")}
                      className="rounded-lg bg-[#22C55E] text-[#0b1f14] text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                    >
                      ✅ Confirm
                    </button>
                    <button
                      type="button"
                      disabled={markingId === r.id}
                      onClick={() => void handleAppointmentAction(r.id, "declined")}
                      className="rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                    >
                      ❌ Decline
                    </button>
                  </div>
              )}

              {(r as any).appointment_time && (r as any).appointment_status === "confirmed" && (
                <div className="rounded-lg border border-[#22C55E]/40 bg-[#22C55E]/10 px-3 py-2 text-[11px] text-[#22C55E] font-semibold text-center">
                  ✅ Appointment Confirmed
                </div>
              )}

              {(r as any).appointment_time && (r as any).appointment_status === "declined" && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive font-semibold text-center">
                  ❌ Appointment Declined
                </div>
              )}

              {(r as any).appointment_time &&
                (r as any).appointment_status === "confirmed" &&
                r.status !== "fulfilled" &&
                (() => {
                  const appointmentDate = new Date((r as any).appointment_time);
                  const today = new Date();
                  const isSameDay = appointmentDate.toDateString() === today.toDateString();
                  const isPast = appointmentDate < today;

                  if (isPast) return null;

                  if (!isSameDay) {
                    return (
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        Cancel Appointment
                      </button>
                    );
                  }

                  if (!calledUser[r.id]) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400 text-center">
                          ⚠️ Same-day cancellation — call customer first
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            window.open(`tel:${r.user_phone}`, "_self");
                            setTimeout(() => setCalledUser((p) => ({ ...p, [r.id]: true })), 3000);
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
                        ✅ Call done — you may now cancel
                      </p>
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        Cancel Appointment
                      </button>
                    </div>
                  );
                })()}

              <button
                type="button"
                onClick={() => {
                  if (r.user_phone) {
                    window.open(`tel:+91${r.user_phone.replace(/\D/g, "")}`, "_self");
                  }
                }}
                className="inline-flex w-full items-center justify-center rounded-lg border border-[#22C55E]/40 bg-transparent text-[#22C55E] text-[11px] font-semibold py-1.5 px-2 active:scale-[0.99] transition-transform hover:bg-[#22C55E]/5"
              >
                📞 Connect via AI-Bridge
              </button>
              {r.status !== "done" && r.status !== "fulfilled" && (
                <button
                  type="button"
                  disabled={markingId === r.id}
                  onClick={() => void markDone(r.id)}
                  className="w-full rounded-lg border border-[#22C55E]/50 bg-[#22C55E]/10 text-[#22C55E] text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === r.id ? "Saving…" : "✅ Mark Done"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
