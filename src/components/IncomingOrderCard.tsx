import { Loader2 } from "lucide-react";
import { useCategoryLabel } from "@/lib/supabase";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { openGoogleMaps, resolveVendorNavigateToCustomerUrl } from "@/lib/mapsDeepLink";
import { billBlocksDismiss } from "@/lib/dismissBillGate";
import {
  hasSentIveStarted,
  shouldShowIveStartedButton,
} from "@/lib/vendorTrackingPolicy";

type TrustInfo = {
  trust_score: number;
  total_orders: number;
  is_banned: boolean;
  ban_reason: string | null;
} | null;

export type IncomingOrderCardRow = OrderRequestRow & {
  payment_status?: string;
  payment_utr?: string | null;
};

export type IncomingOrderBillSummary = {
  id: string;
  total_amount: number;
  payment_mode: "cash" | "upi" | "khata";
  payment_status: string;
  last_vendor_reminder_at?: string | null;
};

export type IncomingEditBillTarget = {
  billId: string;
  requestId: string;
  userPhone: string | null;
  total_amount: number;
  payment_mode: IncomingOrderBillSummary["payment_mode"];
  payment_status: string;
};

function getUserTrustBadge(
  trust: TrustInfo | undefined,
  labels: {
    newUser: string;
    trusted: string;
    complaints: string;
    risky: string;
  },
): { label: string; className: string } | null {
  if (trust === undefined) return null;
  if (trust === null || trust.total_orders < 3) {
    return { label: labels.newUser, className: "text-blue-500/80" };
  }
  if (trust.trust_score >= 75) {
    return { label: labels.trusted, className: "text-green-600 dark:text-green-500" };
  }
  if (trust.trust_score >= 50) {
    return { label: labels.complaints, className: "text-amber-600 dark:text-amber-500" };
  }
  return { label: labels.risky, className: "text-red-600 dark:text-red-500" };
}

function getKhataCreditBadge(
  outstanding: number,
  amberLimit: number,
  redLimit: number,
  labels: { creditAmber: string; creditRed: string },
): { label: string; className: string } | null {
  if (redLimit > 0 && outstanding >= redLimit) {
    return {
      label: labels.creditRed,
      className:
        "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
    };
  }
  if (amberLimit > 0 && outstanding >= amberLimit) {
    return {
      label: labels.creditAmber,
      className:
        "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    };
  }
  return null;
}

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

function maskPhoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `••••${digits.slice(-4)}`;
}

function orderEffectiveMode(
  order: Pick<OrderRequestRow, "service_mode" | "delivery_slot" | "appointment_time">,
  fallback: "help" | "delivery" | "appointment" | "booking" | null | undefined,
): "help" | "delivery" | "appointment" | "booking" {
  if (
    order.service_mode === "help" ||
    order.service_mode === "delivery" ||
    order.service_mode === "appointment"
  ) {
    return order.service_mode;
  }
  if (order.delivery_slot) return "delivery";
  if (order.appointment_time) return "appointment";
  if (fallback === "delivery" || fallback === "appointment" || fallback === "booking") {
    return fallback === "booking" ? "appointment" : fallback;
  }
  return "help";
}

function canShowBillButton(r: OrderRequestRow): boolean {
  if (r.appointment_time) {
    if (r.appointment_status !== "confirmed") return false;
    return r.status === "accepted" || r.status === "fulfilled";
  }
  return r.status === "accepted" || r.status === "fulfilled";
}

function acceptedStatusLabel(
  order: Pick<OrderRequestRow, "appointment_status" | "status">,
  serviceMode: "help" | "delivery" | "appointment" | "booking" | null | undefined,
  s: ReturnType<typeof useLanguage>["s"],
): string {
  if (serviceMode !== "appointment") {
    return s.status_accepted;
  }
  return order.appointment_status === "confirmed"
    ? s.status_accepted_appointment_confirmed
    : s.status_accepted_appointment_awaiting;
}

function statusBadge(
  order: Pick<OrderRequestRow, "status" | "appointment_status">,
  serviceMode: "help" | "delivery" | "appointment" | "booking" | null | undefined,
  s: ReturnType<typeof useLanguage>["s"],
) {
  const status = order.status;
  if (status === "sent")
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-xs font-bold px-2 py-0.5 border border-brand/40"
      >
        {s.incoming_statusNew}
      </span>
    );
  if (status === "seen")
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full bg-muted text-muted-foreground text-xs font-semibold px-2 py-0.5 border border-border"
      >
        {s.incoming_statusSeen}
      </span>
    );
  if (status === "accepted")
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-xs font-semibold px-2 py-0.5 border border-brand/40"
      >
        {acceptedStatusLabel(order, serviceMode, s)}
      </span>
    );
  if (status === "fulfilled")
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full text-xs font-semibold px-2 py-0.5 border border-brand-border text-brand"
      >
        {s.incoming_statusDone}
      </span>
    );
  if (status === "cancelled")
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full bg-muted text-muted-foreground text-xs font-semibold px-2 py-0.5 border border-border"
      >
        {s.orderCancelled}
      </span>
    );
  return (
    <span
      data-testid="incoming-order-status"
      className="rounded-full text-xs font-semibold px-2 py-0.5 border border-brand-border text-brand"
    >
      {s.incoming_statusDone}
    </span>
  );
}

function shouldShowStatusBadge(order: OrderRequestRow) {
  if (order.appointment_status === "declined") return false;
  if (order.status === "cancelled" || order.status === "fulfilled" || order.status === "done") {
    return false;
  }
  return true;
}

export type IncomingOrderCardProps = {
  order: IncomingOrderCardRow;
  flash: boolean;
  serviceMode?: "help" | "delivery" | "appointment" | "booking" | null;
  markingId: string | null;
  confirmingPaymentId: string | null;
  disputingPaymentId: string | null;
  markingBillPaidId: string | null;
  remindingBillId: string | null;
  addingBillToKhataId: string | null;
  khataAmberLimit: number;
  khataRedLimit: number;
  khataOutstandingByPhone: Map<string, number>;
  trustByPhone: Record<string, TrustInfo>;
  appointmentOverlaps: boolean;
  bill: IncomingOrderBillSummary | undefined;
  billEdited: boolean;
  hasLedger: boolean;
  dismissBlockedByKhata: boolean;
  isFlagged: boolean;
  iveStartedTick: number;
  slotLabels: Record<string, string>;
  appointmentDateLocale: string;
  isBillRemindDebounced: (billId: string) => boolean;
  onClearEditedFlag: (orderId: string) => void;
  onAppointmentConfirm: (orderId: string) => void;
  onOpenDecline: (orderId: string) => void;
  onOpenCancel: (orderId: string) => void;
  onIveStarted: (order: IncomingOrderCardRow) => void;
  onCallCustomer: (
    phone: string,
    mode: "help" | "delivery" | "appointment" | "booking",
  ) => void;
  onMarkDone: (orderId: string) => void;
  onDismiss: (orderId: string) => void;
  onAcceptHelp: (orderId: string) => void;
  onAcceptDelivery: (orderId: string, userPhone: string | null) => void;
  onOpenFlag: (order: IncomingOrderCardRow) => void;
  onOpenBill: (order: IncomingOrderCardRow) => void;
  onOpenBillHistory: (billId: string) => void;
  onMarkBillPaid: (billId: string, requestId: string) => void;
  onRemindCustomer: (billId: string, requestId: string) => void;
  onAddBillToKhata: (
    bill: IncomingOrderBillSummary,
    requestId: string,
    userPhone: string | null,
  ) => void;
  onEditBill: (target: IncomingEditBillTarget) => void;
  onOpenLedger: (order: IncomingOrderCardRow) => void;
  onConfirmPayment: (
    requestId: string,
    userPhone: string,
    utr: string | null,
    amount: number | null,
  ) => void;
  onDisputePayment: (requestId: string, userPhone: string) => void;
};

export function IncomingOrderCard({
  order,
  flash,
  serviceMode,
  markingId,
  confirmingPaymentId,
  disputingPaymentId,
  markingBillPaidId,
  remindingBillId,
  addingBillToKhataId,
  khataAmberLimit,
  khataRedLimit,
  khataOutstandingByPhone,
  trustByPhone,
  appointmentOverlaps,
  bill,
  billEdited,
  hasLedger,
  dismissBlockedByKhata,
  isFlagged,
  iveStartedTick,
  slotLabels,
  appointmentDateLocale,
  isBillRemindDebounced,
  onClearEditedFlag,
  onAppointmentConfirm,
  onOpenDecline,
  onOpenCancel,
  onIveStarted,
  onCallCustomer,
  onMarkDone,
  onDismiss,
  onAcceptHelp,
  onAcceptDelivery,
  onOpenFlag,
  onOpenBill,
  onOpenBillHistory,
  onMarkBillPaid,
  onRemindCustomer,
  onAddBillToKhata,
  onEditBill,
  onOpenLedger,
  onConfirmPayment,
  onDisputePayment,
}: IncomingOrderCardProps) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const trustBadgeLabels = {
    newUser: s.incoming_trust_new_user,
    trusted: s.incoming_trust_trusted,
    complaints: s.incoming_trust_complaints,
    risky: s.incoming_trust_risky,
  };

  const orderMode = orderEffectiveMode(order, serviceMode);
  const orderIsHelp = orderMode === "help";
  const orderCanAddToLedger =
    orderMode === "appointment" || orderMode === "delivery" || orderMode === "booking";

  return (
            <li
              id={`order-card-${order.id}`}
              data-testid="incoming-order-card"
              className={cn(
                "rounded-xl border border-border bg-muted/30 p-3 space-y-2",
                flash &&
                  "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse",
              )}
              onClick={() => onClearEditedFlag(order.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatTimeAgo(order.created_at)}
                </span>
                {shouldShowStatusBadge(order) && statusBadge(order, serviceMode, s)}
              </div>
              {(() => {
                const cat = Array.isArray(order.categories) ? order.categories[0] : order.categories;
                if (!cat?.label) return null;
                return (
                  <span
                    data-testid="incoming-order-category"
                    className="inline-flex items-center gap-0.5 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-semibold text-foreground w-fit"
                  >
                    {cat.emoji ? <span aria-hidden>{cat.emoji}</span> : null}
                    <span>{getLabel(cat.label)}</span>
                  </span>
                );
              })()}
              <div className="flex items-start gap-2">
                <p className="flex-1 min-w-0 text-sm text-foreground leading-snug whitespace-pre-wrap break-words">
                  {stripLocationTag(order.message)}
                </p>
                {order.is_edited && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-semibold px-2 py-0.5 border border-amber-500/30">
                    {s.order_edited_badge}
                  </span>
                )}
              </div>
              {order.user_phone && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {maskPhoneLast4(order.user_phone.trim())}
                  </span>
                  {khataAmberLimit > 0 &&
                    (() => {
                      const phone = order.user_phone.trim();
                      if (!khataOutstandingByPhone.has(phone)) return null;
                      const outstanding = khataOutstandingByPhone.get(phone) ?? 0;
                      const creditBadge = getKhataCreditBadge(
                        outstanding,
                        khataAmberLimit,
                        khataRedLimit,
                        { creditAmber: s.khata_creditAmber, creditRed: s.khata_creditRed },
                      );
                      if (!creditBadge) return null;
                      return (
                        <span
                          className={cn(
                            "inline-flex rounded-full text-xs font-semibold px-2 py-0.5 border",
                            creditBadge.className,
                          )}
                        >
                          {creditBadge.label}
                        </span>
                      );
                    })()}
                  {(() => {
                    const trustBadge = getUserTrustBadge(
                      trustByPhone[order.user_phone.trim()],
                      trustBadgeLabels,
                    );
                    if (!trustBadge) return null;
                    return (
                      <span className={cn("text-xs font-normal", trustBadge.className)}>
                        {trustBadge.label}
                      </span>
                    );
                  })()}
                </div>
              )}
              {order.status === "cancelled" && order.cancel_reason && (
                <span className="inline-flex rounded-full bg-muted text-muted-foreground text-xs font-medium px-2 py-0.5 border border-border">
                  {order.cancel_reason}
                </span>
              )}
              {order.delivery_address && (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {s.incoming_addressPrefix}<span className="text-foreground font-medium">{order.delivery_address}</span>
                </div>
              )}

              {(() => {
                const mapsUrl = resolveVendorNavigateToCustomerUrl(orderMode, order);
                if (!mapsUrl) return null;
                return (
                  <button
                    type="button"
                    data-testid="incoming-open-maps-btn"
                    onClick={() => openGoogleMaps(mapsUrl)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                  >
                    🗺️ {s.maps_openInMaps}
                  </button>
                );
              })()}

              {(() => {
                const slot = deliverySlotLabel(order.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="rounded-lg border border-brand-border bg-brand/5 px-3 py-2 text-xs">
                    {s.incoming_slotPrefix}<span className="text-green-700 dark:text-brand font-semibold">{slot}</span>
                  </div>
                );
              })()}

              {order.appointment_time &&
                (() => {
                  const msg = order.message ?? "";
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
                    <div className={`rounded-lg border px-3 py-2 text-xs space-y-0.5 ${colorClass}`}>
                      <div className="font-semibold">{locationLabel}</div>
                      <div>
                        {s.incoming_apptAround}
                        <span className="font-semibold">
                          {new Date(order.appointment_time).toLocaleString(appointmentDateLocale, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {appointmentOverlaps && (
                        <p
                          data-testid="incoming-appointment-overlap"
                          className="text-muted-foreground font-normal pt-0.5"
                        >
                          {s.incoming_appointmentOverlap}
                        </p>
                      )}
                    </div>
                  );
                })()}

              {order.appointment_time && order.appointment_status === "pending" && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="incoming-accept-btn"
                    disabled={markingId === order.id}
                    onClick={() => onAppointmentConfirm(order.id)}
                    className="min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {s.incoming_btnConfirm}
                  </button>
                  <button
                    type="button"
                    data-testid="incoming-decline-btn"
                    disabled={markingId === order.id}
                    onClick={() => onOpenDecline(order.id)}
                    className="rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {s.incoming_btnDecline}
                  </button>
                </div>
              )}

              {order.appointment_time &&
                order.appointment_status === "confirmed" &&
                order.status !== "cancelled" && (
                <>
                  {order.status !== "fulfilled" && order.status !== "done" && (
                    <span
                      data-testid="incoming-order-status"
                      className="inline-flex rounded-full bg-brand/20 text-green-700 dark:text-brand text-xs font-semibold px-2 py-0.5 border border-brand/40"
                    >
                      {s.incoming_bookingConfirmed}
                    </span>
                  )}
                  {order.status !== "done" &&
                    order.status !== "fulfilled" &&
                    order.status !== "cancelled" && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => onOpenCancel(order.id)}
                          className="w-full rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                        >
                          {s.incoming_cancelBooking}
                        </button>
                        {(() => {
                          void iveStartedTick;
                          const showIve = shouldShowIveStartedButton(order);
                          const sent = hasSentIveStarted(order.id);
                          if (!showIve && !sent) return null;
                          return (
                            <button
                              type="button"
                              data-testid="incoming-ive-started-btn"
                              disabled={sent}
                              onClick={() => onIveStarted(order)}
                              className="w-full rounded-lg border border-brand/50 bg-brand/10 text-brand text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                            >
                              {sent ? s.incoming_iveStarted_sent : s.incoming_iveStarted_btn}
                            </button>
                          );
                        })()}
                        {order.user_phone && (
                          <button
                            type="button"
                            onClick={() => onCallCustomer(order.user_phone!, orderMode)}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                            aria-label={s.incoming_callCustomer}
                          >
                            📞 {s.incoming_callCustomer}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid="incoming-done-btn"
                          disabled={markingId === order.id}
                          onClick={() => onMarkDone(order.id)}
                          className="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                        >
                          {markingId === order.id ? s.incoming_saving : s.incoming_markDone}
                        </button>
                      </div>
                    )}
                </>
              )}

              {order.appointment_time && order.appointment_status === "declined" && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive font-semibold text-center">
                  {s.incoming_bannerDeclined}
                </div>
              )}

              {(order.status === "cancelled" || order.appointment_status === "declined") && (
                <button
                  type="button"
                  disabled={markingId === order.id}
                  onClick={() => onDismiss(order.id)}
                  className="w-full rounded-lg border border-border bg-muted/40 text-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === order.id ? s.incoming_saving : s.incoming_dismiss}
                </button>
              )}

              {!order.appointment_time && orderIsHelp && order.status === "sent" && (
                  <button
                    type="button"
                    data-testid="incoming-accept-btn"
                    disabled={markingId === order.id}
                    onClick={() => onAcceptHelp(order.id)}
                    className="w-full min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {markingId === order.id ? s.incoming_saving : s.incoming_btnAccept}
                  </button>
                )}

              {!order.appointment_time && !orderIsHelp && order.status === "seen" && (
                <button
                  type="button"
                  data-testid="incoming-accept-btn"
                  disabled={markingId === order.id}
                  onClick={() => onAcceptDelivery(order.id, order.user_phone ?? null)}
                  className="w-full min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === order.id ? s.incoming_saving : s.incoming_acceptOrder}
                </button>
              )}

              {!order.appointment_time && (
                <>
                  {(order.status === "sent" || order.status === "seen") && (
                    <button
                      type="button"
                      onClick={() => onOpenCancel(order.id)}
                      className="w-full rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                    >
                      {s.cancelOrder}
                    </button>
                  )}
                  {order.status === "accepted" && (
                    <>
                      {(() => {
                        void iveStartedTick;
                        const showIve = shouldShowIveStartedButton(order);
                        const sent = hasSentIveStarted(order.id);
                        if (!showIve && !sent) return null;
                        return (
                          <button
                            type="button"
                            data-testid="incoming-ive-started-btn"
                            disabled={sent}
                            onClick={() => onIveStarted(order)}
                            className="w-full rounded-lg border border-brand/50 bg-brand/10 text-brand text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                          >
                            {sent ? s.incoming_iveStarted_sent : s.incoming_iveStarted_btn}
                          </button>
                        );
                      })()}
                      {order.user_phone && (
                        <button
                          type="button"
                          onClick={() => onCallCustomer(order.user_phone!, orderMode)}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                          aria-label={s.incoming_callCustomer}
                        >
                          📞 {s.incoming_callCustomer}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="incoming-done-btn"
                        disabled={markingId === order.id}
                        onClick={() => onMarkDone(order.id)}
                        className="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                      >
                        {markingId === order.id ? s.incoming_saving : s.incoming_markDone}
                      </button>
                    </>
                  )}
                  {(order.status === "fulfilled" || order.status === "cancelled") &&
                    order.user_phone &&
                    !isFlagged && (
                      <button
                        type="button"
                        onClick={() => onOpenFlag(order)}
                        className="w-full text-left text-xs text-muted-foreground/80 hover:text-muted-foreground py-1"
                      >
                        {s.incoming_flag_report_btn}
                      </button>
                    )}
                </>
              )}

              {canShowBillButton(order) && (
                <>
                  {(() => {
                    const existingBill = bill;
                    return (
                      <button
                        type="button"
                        data-testid="incoming-bill-btn"
                        onClick={() => {
                          if (existingBill) {
                            document
                              .getElementById(`incoming-bill-preview-${order.id}`)
                              ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                            return;
                          }
                          onOpenBill(order);
                        }}
                        className="w-full rounded-xl border border-primary/50 text-primary text-sm font-semibold h-10 active:scale-[0.99]"
                      >
                        {existingBill ? s.bill_view_title : s.bill_title}
                      </button>
                    );
                  })()}
                  {bill && (
                    <div
                      id={`incoming-bill-preview-${order.id}`}
                      data-testid="incoming-bill-preview"
                      className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-xs font-semibold text-foreground">
                            {s.bill_total}: ₹{bill.total_amount.toFixed(2)}
                          </p>
                          {billEdited && (
                            <button
                              type="button"
                              data-testid="incoming-bill-edited-badge"
                              onClick={() => onOpenBillHistory(bill.id)}
                              className="text-xs font-semibold text-brand underline shrink-0"
                            >
                              {s.bill_editedBadge}
                            </button>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {bill.payment_mode === "cash"
                            ? s.bill_cash
                            : bill.payment_mode === "upi"
                              ? s.bill_upi
                              : s.bill_khata}
                          {" · "}
                          {bill.payment_status === "paid"
                            ? s.bill_statusPaid
                            : s.bill_statusUnpaid}
                        </span>
                      </div>
                      {(bill.payment_mode === "cash" ||
                        bill.payment_mode === "upi") &&
                        bill.payment_status === "unpaid" && (
                          <button
                            type="button"
                            disabled={markingBillPaidId === bill.id}
                            onClick={() => onMarkBillPaid(bill.id, order.id)}
                            className="w-full rounded-lg bg-brand/15 text-brand border border-brand/40 text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {markingBillPaidId === bill.id
                              ? s.incoming_saving
                              : s.khata_markPaid}
                          </button>
                        )}
                      {bill.payment_status === "unpaid" && (
                        <>
                          <button
                            type="button"
                            data-testid="incoming-remind-customer-btn"
                            disabled={
                              remindingBillId === bill.id ||
                              isBillRemindDebounced(bill.id)
                            }
                            onClick={() => onRemindCustomer(bill.id, order.id)}
                            className="w-full rounded-lg border border-amber-500/50 text-amber-500 text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {remindingBillId === bill.id
                              ? s.bill_remind_customer_sending
                              : s.bill_remind_customer}
                          </button>
                          {bill.last_vendor_reminder_at && (
                            <p
                              data-testid="incoming-last-reminded"
                              className="text-xs text-muted-foreground text-center"
                            >
                              {s.bill_remind_customer_last.replace(
                                "{when}",
                                formatTimeAgo(bill.last_vendor_reminder_at!),
                              )}
                            </p>
                          )}
                        </>
                      )}
                      {bill.payment_status === "unpaid" &&
                        bill.payment_mode !== "khata" && (
                          <button
                            type="button"
                            data-testid="incoming-add-bill-to-khata-btn"
                            disabled={addingBillToKhataId === bill.id}
                            onClick={() => onAddBillToKhata(bill, order.id, order.user_phone)}
                            className="w-full rounded-lg border border-primary/50 text-primary text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {addingBillToKhataId === bill.id
                              ? s.incoming_saving
                              : s.bill_addToKhata}
                          </button>
                        )}
                      {bill.payment_status !== "void" && (
                        <button
                          type="button"
                          data-testid="incoming-edit-bill-btn"
                          onClick={() =>
                            onEditBill({
                              billId: bill.id,
                              requestId: order.id,
                              userPhone: order.user_phone,
                              total_amount: bill.total_amount,
                              payment_mode: bill.payment_mode,
                              payment_status: bill.payment_status,
                            })
                          }
                          className="w-full rounded-lg border border-surface-border text-foreground text-xs font-semibold py-2 active:scale-[0.99]"
                        >
                          {s.bill_edit}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {(order.status === "fulfilled" || order.status === "done") && (
                <div className="space-y-2">
                  {orderCanAddToLedger &&
                    order.user_phone &&
                    !hasLedger &&
                    !bill && (
                    <button
                      type="button"
                      onClick={() => onOpenLedger(order)}
                      className="w-full rounded-lg border border-primary/50 text-primary text-xs font-semibold py-2 active:scale-[0.99]"
                    >
                      {s.khata_addToLedger}
                    </button>
                  )}
                  {(() => {
                    const dismissBlockedByUnpaidBill = billBlocksDismiss(bill);
                    const dismissBlocked = dismissBlockedByUnpaidBill || dismissBlockedByKhata;
                    return (
                      <div>
                        <button
                          type="button"
                          data-testid="incoming-dismiss-btn"
                          disabled={markingId === order.id || dismissBlocked}
                          onClick={() => {
                            if (!dismissBlocked) onDismiss(order.id);
                          }}
                          className={cn(
                            "w-full rounded-lg border border-border bg-muted/40 text-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50",
                            dismissBlocked && "opacity-50 cursor-not-allowed",
                          )}
                        >
                          {markingId === order.id ? s.incoming_saving : s.incoming_dismiss}
                        </button>
                        {dismissBlockedByUnpaidBill && (
                          <p
                            data-testid="incoming-dismiss-blocked-unpaid"
                            className="text-xs text-muted-foreground text-center mt-1"
                          >
                            {s.incoming_dismissBlockedUnpaid}
                          </p>
                        )}
                        {!dismissBlockedByUnpaidBill && dismissBlockedByKhata && (
                          <p className="text-xs text-muted-foreground text-center mt-1">
                            {s.khata_settleDuesFirst}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {order.payment_status === "claimed" && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="incoming-confirm-payment-btn"
                    disabled={confirmingPaymentId === order.id || disputingPaymentId === order.id}
                    onClick={() =>
                      onConfirmPayment(
                        order.id,
                        order.user_phone?.trim() || "",
                        order.payment_utr ?? null,
                        bill?.total_amount ?? null,
                      )
                    }
                    className="rounded-lg border border-green-500/50 text-green-600 dark:text-green-400 text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {confirmingPaymentId === order.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {s.payment_confirm_btn}
                  </button>
                  <button
                    type="button"
                    data-testid="dispute-payment-btn"
                    disabled={confirmingPaymentId === order.id || disputingPaymentId === order.id}
                    onClick={() => onDisputePayment(order.id, order.user_phone?.trim() || "")}
                    className="rounded-lg border border-red-500/50 text-red-500 text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {disputingPaymentId === order.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {s.payment_dispute_btn}
                  </button>
                </div>
              )}
            </li>
  );
}
