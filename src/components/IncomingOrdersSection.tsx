import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatTimeAgo, buildRequestsActiveWindowOrFilter, type OrderRequestRow } from "@/lib/orders";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Props = {
  vendorId: string;
  serviceMode?: "help" | "delivery" | "appointment" | null;
  onUnreadCount?: (n: number) => void;
};

function stripLocationTag(message: string): string {
  return message
    .replace(/\s*\[Come to my place\]/g, "")
    .replace(/\s*\[I'll visit your shop\]/g, "")
    .replace(/\s*\[Location TBD\]/g, "")
    .trim();
}

function deliverySlotLabel(
  slot: string | null | undefined,
  labels: Record<string, string>,
): string | null {
  if (!slot?.trim()) return null;
  return labels[slot.trim().toLowerCase()] ?? slot;
}

export function IncomingOrdersSection({ vendorId, serviceMode, onUnreadCount }: Props) {
  const isHelpMode = serviceMode === "help";
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
  const [rows, setRows] = useState<OrderRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [calledUser, setCalledUser] = useState<Record<string, boolean>>({});
  const [presetReasons, setPresetReasons] = useState<string[]>([]);
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [otherReasonText, setOtherReasonText] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(true);

  const selectFields =
    "id, device_id, vendor_id, message, status, created_at, user_phone, delivery_address, delivery_slot, appointment_time, appointment_status, cancel_reason";

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      const windowOr = buildRequestsActiveWindowOrFilter("vendor");
      const { data, error } = await supabase
        .from("requests")
        .select(selectFields)
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

      const hadSent = !isHelpMode && list.some((r) => r.status === "sent");
      if (hadSent) {
        const { error: upErr } = await supabase
          .from("requests")
          .update({ status: "seen" })
          .eq("vendor_id", vendorId)
          .eq("status", "sent");
        if (upErr || !mounted.current) return;
        const { data: refreshed } = await supabase
          .from("requests")
          .select(selectFields)
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
    [vendorId, onUnreadCount, isHelpMode],
  );

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("vendors")
        .select("cancel_reason_1, cancel_reason_2, cancel_reason_3, cancel_reason_4")
        .eq("id", vendorId)
        .single();
      if (!data) return;
      const presets = [
        data.cancel_reason_1,
        data.cancel_reason_2,
        data.cancel_reason_3,
        data.cancel_reason_4,
      ].filter((r): r is string => r != null && String(r).trim() !== "");
      setPresetReasons(presets);
    })();
  }, [vendorId]);

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

  const acceptHelpOrder = async (id: string) => {
    setMarkingId(id);
    const { data, error } = await supabase
      .from("requests")
      .update({ status: "accepted" })
      .eq("id", id)
      .eq("status", "sent")
      .select("id");
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
      return;
    }
    if (!data?.length) {
      toast.error(s.order_already_taken);
      setRows((prev) => prev.filter((r) => r.id !== id));
      return;
    }
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, status: "accepted" } : r));
      onUnreadCount?.(next.filter((r) => r.status === "sent").length);
      return next;
    });
  };

  const markDone = async (id: string) => {
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ status: "fulfilled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
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
      toast.error(s.incoming_errCouldNotUpdateAppt, { description: error.message });
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === id ? ({ ...r, appointment_status: action } as any) : r)),
    );
    toast.success(action === "confirmed" ? s.incoming_apptConfirmed : s.incoming_apptDeclined);
  };

  const closeCancelSheet = () => {
    setCancelOrderId(null);
    setSelectedReason(null);
    setOtherReasonText("");
  };

  const confirmCancelOrder = async () => {
    if (!cancelOrderId || !selectedReason) return;
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    setCancelling(true);
    const { error } = await supabase
      .from("requests")
      .update({ status: "cancelled", cancel_reason: reasonText })
      .eq("id", cancelOrderId)
      .eq("vendor_id", vendorId);
    setCancelling(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(s.orderCancelled);
    setRows((prev) =>
      prev.map((r) =>
        r.id === cancelOrderId ? { ...r, status: "cancelled", cancel_reason: reasonText } : r,
      ),
    );
    closeCancelSheet();
  };

  const cancelAppointment = async (id: string) => {
    const { error } = await supabase
      .from("requests")
      .update({ appointment_status: "cancelled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    if (error) {
      toast.error(s.incoming_errCouldNotCancel, { description: error.message });
      return;
    }
    toast.success(s.incoming_bookingCancelled);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? ({ ...r, appointment_status: "cancelled" } as any) : r)),
    );
  };

  const unread = rows.filter((r) => r.status === "sent").length;

  const badge = (status: string) => {
    if (status === "sent")
      return (
        <span className="rounded-full bg-brand/20 text-brand text-[10px] font-bold px-2 py-0.5 border border-brand/40">
          {s.incoming_statusNew}
        </span>
      );
    if (status === "seen")
      return (
        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
          {s.incoming_statusSeen}
        </span>
      );
    if (status === "accepted")
      return (
        <span className="rounded-full bg-brand/20 text-brand text-[10px] font-semibold px-2 py-0.5 border border-brand/40">
          {s.status_accepted}
        </span>
      );
    if (status === "fulfilled")
      return (
        <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand">
          {s.incoming_statusDone}
        </span>
      );
    if (status === "cancelled")
      return (
        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
          {s.orderCancelled}
        </span>
      );
    return (
      <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand">
        {s.incoming_statusDone}
      </span>
    );
  };

  return (
    <div className="rounded-2xl bg-card border border-border shadow-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display font-bold text-base flex items-center gap-2">
          {s.incoming_heading}
          {unread > 0 && (
            <span className="rounded-full bg-brand text-[#0b1f14] text-[11px] font-bold min-w-[1.25rem] h-5 px-1.5 grid place-items-center tabular-nums">
              {unread > 99 ? s.incoming_unreadCap : unread}
            </span>
          )}
        </h2>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">{s.incoming_empty}</p>
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
                {stripLocationTag(r.message)}
              </p>
              {r.status === "cancelled" && r.cancel_reason && (
                <span className="inline-flex rounded-full bg-muted text-muted-foreground text-[10px] font-medium px-2 py-0.5 border border-border">
                  {r.cancel_reason}
                </span>
              )}
              {(r as any).delivery_address && (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  {s.incoming_addressPrefix}<span className="text-foreground font-medium">{(r as any).delivery_address}</span>
                </div>
              )}

              {(() => {
                const slot = deliverySlotLabel(r.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="rounded-lg border border-brand-border bg-brand/5 px-3 py-2 text-[11px]">
                    {s.incoming_slotPrefix}<span className="text-brand font-semibold">{slot}</span>
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
                    ? s.incoming_locationComeToYou
                    : isShop
                      ? s.incoming_locationVisitShop
                      : s.incoming_locationTbd;
                  return (
                    <div className={`rounded-lg border px-3 py-2 text-[11px] space-y-0.5 ${colorClass}`}>
                      <div className="font-semibold">{locationLabel}</div>
                      <div>
                        {s.incoming_apptAround}
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
                      className="rounded-lg bg-brand text-[#0b1f14] text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                    >
                      {s.incoming_btnConfirm}
                    </button>
                    <button
                      type="button"
                      disabled={markingId === r.id}
                      onClick={() => void handleAppointmentAction(r.id, "declined")}
                      className="rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                    >
                      {s.incoming_btnDecline}
                    </button>
                  </div>
              )}

              {(r as any).appointment_time && (r as any).appointment_status === "confirmed" && (
                <div className="rounded-lg border border-brand/40 bg-brand-muted px-3 py-2 text-[11px] text-brand font-semibold text-center">
                  {s.incoming_bannerConfirmed}
                </div>
              )}

              {(r as any).appointment_time && (r as any).appointment_status === "declined" && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive font-semibold text-center">
                  {s.incoming_bannerDeclined}
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
                        {s.incoming_cancelAppt}
                      </button>
                    );
                  }

                  if (!calledUser[r.id]) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400 text-center">
                          {s.incoming_sameDayWarning}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            window.open(`tel:${r.user_phone}`, "_self");
                            setTimeout(() => setCalledUser((p) => ({ ...p, [r.id]: true })), 3000);
                          }}
                          className="w-full rounded-lg border border-brand/40 text-brand text-xs font-semibold py-2"
                        >
                          {s.incoming_callThenCancel}
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      <p className="text-[11px] text-gray-400 text-center">
                        {s.incoming_callDone}
                      </p>
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r.id)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.incoming_cancelAppt}
                      </button>
                    </div>
                  );
                })()}

              {isHelpMode && r.status === "sent" && (
                  <button
                    type="button"
                    disabled={markingId === r.id}
                    onClick={() => void acceptHelpOrder(r.id)}
                    className="w-full rounded-lg bg-brand text-[#0b1f14] text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {markingId === r.id ? s.incoming_saving : s.incoming_btnAccept}
                  </button>
                )}

              {(r.status === "sent" || r.status === "seen") && (
                <button
                  type="button"
                  onClick={() => {
                    setCancelOrderId(r.id);
                    setSelectedReason(null);
                    setOtherReasonText("");
                  }}
                  className="w-full rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                >
                  {s.cancelOrder}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (r.user_phone) {
                    window.open(`tel:+91${r.user_phone.replace(/\D/g, "")}`, "_self");
                  }
                }}
                className="inline-flex w-full items-center justify-center rounded-lg border border-brand/40 bg-transparent text-brand text-[11px] font-semibold py-1.5 px-2 active:scale-[0.99] transition-transform hover:bg-brand/5"
              >
                {s.incoming_callBridge}
              </button>
              {r.status !== "done" && r.status !== "fulfilled" && r.status !== "cancelled" && (
                <button
                  type="button"
                  disabled={markingId === r.id}
                  onClick={() => void markDone(r.id)}
                  className="w-full rounded-lg border border-brand/50 bg-brand-muted text-brand text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === r.id ? s.incoming_saving : s.incoming_markDone}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Sheet open={cancelOrderId != null} onOpenChange={(open) => !open && closeCancelSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>{s.cancelReason}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex flex-wrap gap-2">
            {presetReasons.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => {
                  setSelectedReason(reason);
                  setOtherReasonText("");
                }}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                  selectedReason === reason
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-border bg-muted/40 text-foreground",
                )}
              >
                {reason}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSelectedReason("Other")}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                selectedReason === "Other"
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border bg-muted/40 text-foreground",
              )}
            >
              {s.other}
            </button>
          </div>
          {selectedReason === "Other" && (
            <input
              type="text"
              value={otherReasonText}
              onChange={(e) => setOtherReasonText(e.target.value.slice(0, 80))}
              maxLength={80}
              placeholder={s.cancelReasonPlaceholder}
              className="mt-3 w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          <button
            type="button"
            disabled={
              cancelling ||
              !selectedReason ||
              (selectedReason === "Other" && !otherReasonText.trim())
            }
            onClick={() => void confirmCancelOrder()}
            className="mt-4 w-full rounded-xl bg-destructive text-destructive-foreground py-3 font-semibold disabled:opacity-50"
          >
            {cancelling ? s.incoming_saving : s.confirmCancel}
          </button>
        </SheetContent>
      </Sheet>
    </div>
  );
}
