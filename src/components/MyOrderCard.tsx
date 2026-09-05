import { Loader2, Pencil } from "lucide-react";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { openGoogleMaps, resolveCustomerNavigateToVendorUrl } from "@/lib/mapsDeepLink";
import { billBlocksDismiss } from "@/lib/dismissBillGate";
import { customerOrderShowsLiveLocation } from "@/lib/vendorTrackingPolicy";
import {
  canShowCustomerCancelOrder,
  canShowPreAcceptCancel,
} from "@/lib/customerCancelPolicy";
import { isHelpAcceptDelayed, formatHelpDelayedWarning } from "@/lib/orderHelpDelay";
import {
  canCustomerSelfDeclarePayment,
  isCustomerSelfDeclarePaymentEligible,
} from "@/lib/customerPaymentGate";
import { isBillPastPaymentHygieneTier1 } from "@/lib/paymentHygiene";
import { distanceMeters } from "@/lib/supabase";

export type MyOrderCardRow = OrderRequestRow & {
  vendors: {
    shop_name: string;
    service_mode: string | null;
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  payment_status?: string;
};

export type MyOrderBill = {
  id: string;
  total_amount: number;
  payment_mode: "cash" | "upi" | "khata";
  payment_status: "unpaid" | "paid";
  created_at: string;
  notes: string | null;
  items: {
    description: string;
    quantity: number;
    unit: string | null;
    unit_price: number;
    total_price: number;
  }[];
};

export type MyOrderReview = {
  id: string;
  rating: number;
  review_text: string | null;
  created_at: string;
  vendor_response?: string | null;
  vendor_responded_at?: string | null;
};

type VendorLive = {
  latitude: number;
  longitude: number;
  lastUpdated: string;
};

function fulfilledOrderCtaLabel(
  serviceMode: string | null | undefined,
  labels: {
    myOrders_delivered: string;
    myOrders_appointmentFulfilled: string;
    rating_btnHelped: string;
  },
): string {
  const mode = String(serviceMode ?? "delivery").trim().toLowerCase();
  if (mode === "appointment") return labels.myOrders_appointmentFulfilled;
  if (mode === "delivery") return labels.myOrders_delivered;
  return labels.rating_btnHelped;
}

function formatVendorDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} mtr away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

const MS_24H = 24 * 60 * 60 * 1000;

function orderCreatedWithinLast24h(created_at: string): boolean {
  const t = new Date(created_at).getTime();
  return Number.isFinite(t) && Date.now() - t < MS_24H;
}

const cancelledOrderStatusLabel = (
  r: Pick<OrderRequestRow, "cancel_reason">,
  s: ReturnType<typeof useLanguage>["s"],
) => (r.cancel_reason?.trim() ? s.order_cancelled_by_vendor : s.order_cancelled_by_you);

const userStatusLabel = (
  r: Pick<OrderRequestRow, "status" | "created_at" | "appointment_status" | "cancel_reason"> & {
    vendors?: { service_mode: string | null } | null;
  },
  s: ReturnType<typeof useLanguage>["s"],
) => {
  if (r.status === "accepted" && r.vendors?.service_mode === "appointment") {
    return r.appointment_status === "confirmed"
      ? s.status_accepted_appointment_confirmed
      : s.status_accepted_appointment_awaiting;
  }
  if (r.appointment_status === "confirmed") return s.myOrders_apptConfirmed;
  if (r.appointment_status === "declined") return s.myOrders_apptDeclined;
  if (r.status === "accepted" && r.vendors?.service_mode === "delivery") {
    return s.status_accepted_delivery;
  }
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
  if (r.status === "cancelled") return cancelledOrderStatusLabel(r, s);
  if (r.status === "expired") return s.myOrders_statusExpired;
  return r.status;
};

function canShowRemoveOrder(
  r: Parameters<typeof canShowCustomerCancelOrder>[0],
): boolean {
  return canShowCustomerCancelOrder(r);
}

function isHelpAcceptDelayedRow(
  r: Pick<OrderRequestRow, "updated_at" | "created_at">,
  timeoutHours: number,
): boolean {
  return isHelpAcceptDelayed(r.updated_at, r.created_at, timeoutHours);
}

function isDeliveryAcceptedOverdue(
  r: Pick<OrderRequestRow, "status" | "delivery_slot_deadline"> & {
    vendors?: { service_mode: string | null } | null;
  },
): boolean {
  if (r.status !== "accepted" || r.vendors?.service_mode !== "delivery") return false;
  const deadline = r.delivery_slot_deadline;
  if (deadline == null || String(deadline).trim() === "") return false;
  const t = new Date(deadline).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
}


function isBookingConfirmedOverdue(
  r: Pick<OrderRequestRow, "appointment_time" | "appointment_status" | "status">,
): boolean {
  if (r.status === "fulfilled" || r.status === "done") return false;
  if (r.appointment_status !== "confirmed") return false;
  const time = r.appointment_time;
  if (time == null || String(time).trim() === "") return false;
  const t = new Date(time).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
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

function orderStatusPillClass(order: MyOrderCardRow) {
  if (order.status === "cancelled") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (order.status === "expired") return "bg-amber-500/20 text-amber-500 border-amber-500/30";
  if (order.status === "fulfilled" || order.status === "done")
    return "bg-green-500/20 text-green-400 border-green-500/30";
  return "bg-brand/20 text-brand border-brand/30";
}

export type MyOrderCardProps = {
  order: MyOrderCardRow;
  flash: boolean;
  isMarking: boolean;
  bill: MyOrderBill | undefined;
  billEdited: boolean;
  review: MyOrderReview | undefined;
  vendorLive: VendorLive | undefined;
  vendorStopped: boolean;
  hasCalledVendor: boolean;
  showCancelConfirm: boolean;
  showOrderCancelConfirm: boolean;
  paymentSheetLoading: boolean;
  isPaymentBlockRequest: boolean;
  paymentSelfDeclareRestricted: boolean;
  paymentBlockRequestId: string | null;
  userCoords: { lat: number; lng: number } | null;
  locationTick: number;
  helpAcceptTimeoutHours: number;
  slotLabels: Record<string, string>;
  onOpenEdit: (order: MyOrderCardRow) => void;
  onRemoveOrder: (order: MyOrderCardRow) => void;
  onMarkDone: (order: MyOrderCardRow) => void;
  onOpenBillHistory: (billId: string) => void;
  onHelpVendorCall: (order: MyOrderCardRow) => void;
  onOpenPayment: (order: MyOrderCardRow, bill: MyOrderBill) => void;
  onEditReview: (payload: {
    id: string;
    vendorId: string;
    rating: number;
    text: string;
  }) => void;
  onCancelAppointment: (order: MyOrderCardRow) => void;
  onSetShowCancelConfirm: (open: boolean) => void;
  onMarkCalledVendorSoon: () => void;
  onFulfilledDismiss: (order: MyOrderCardRow) => void;
  onSetShowOrderCancelConfirm: (open: boolean) => void;
};

export function MyOrderCard({
  order,
  flash,
  isMarking,
  bill,
  billEdited,
  review,
  vendorLive,
  vendorStopped,
  hasCalledVendor,
  showCancelConfirm,
  showOrderCancelConfirm,
  paymentSheetLoading,
  isPaymentBlockRequest,
  paymentSelfDeclareRestricted,
  paymentBlockRequestId,
  userCoords,
  locationTick,
  helpAcceptTimeoutHours,
  slotLabels,
  onOpenEdit,
  onRemoveOrder,
  onMarkDone,
  onOpenBillHistory,
  onHelpVendorCall,
  onOpenPayment,
  onEditReview,
  onCancelAppointment,
  onSetShowCancelConfirm,
  onMarkCalledVendorSoon,
  onFulfilledDismiss,
  onSetShowOrderCancelConfirm,
}: MyOrderCardProps) {
  const { s } = useLanguage();
  // Alias for JSX that still references markingId === ...
  const markingId = isMarking ? order.id : null;

  return (
            <li
              id={`order-card-${order.id}`}
              data-testid="order-card"
              className={cn(
                "rounded-2xl border border-surface-border bg-surface p-4 space-y-2 mb-3",
                order.status === "cancelled" && "border-red-500/30 bg-red-500/5",
                order.status === "expired" && "border-amber-500/30 bg-amber-500/5",
                flash &&
                  "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p
                  className="font-semibold text-foreground truncate min-w-0"
                  title={order.vendors?.shop_name ?? s.myOrders_shopFallback}
                >
                  {order.vendors?.shop_name ?? s.myOrders_shopFallback}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  {(order.status === "sent" || order.status === "seen") &&
                    order.appointment_status !== "declined" && (
                    <button
                      type="button"
                      onClick={() => onOpenEdit(order)}
                      className="h-8 w-8 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
                      aria-label={s.editOrder}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatTimeAgo(order.created_at)}
                  </span>
                </div>
              </div>
              <span
                data-testid="order-status-badge"
                className={cn(
                  "inline-flex rounded-full text-xs font-semibold px-3 py-1 border",
                  orderStatusPillClass(order),
                )}
              >
                {userStatusLabel(order, s)}
              </span>
              {isDeliveryAcceptedOverdue(order) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                  <p className="text-xs text-amber-400 text-center leading-snug font-semibold">
                    {s.delivery_accepted_overdue_title}
                  </p>
                  <p className="text-xs text-amber-400 text-center leading-snug">
                    {s.delivery_accepted_overdue_body}
                  </p>
                  {canShowCustomerCancelOrder(order) ? (
                    <button
                      type="button"
                      data-testid="order-cancel-btn"
                      disabled={isMarking}
                      onClick={() => onRemoveOrder(order)}
                      className="w-full rounded-xl border border-destructive/40 text-destructive text-sm font-semibold h-10 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking ? s.myOrders_saving : s.myOrders_cancelOrder}
                    </button>
                  ) : billBlocksDismiss(bill) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-xs text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={isMarking}
                      onClick={() => onMarkDone(order)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )}
                </div>
              )}
              {isBookingConfirmedOverdue(order) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                  <p className="text-xs text-amber-400 text-center leading-snug font-semibold">
                    {s.booking_confirmed_overdue_title}
                  </p>
                  <p className="text-xs text-amber-400 text-center leading-snug">
                    {s.booking_confirmed_overdue_body}
                  </p>
                  {billBlocksDismiss(bill) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-xs text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={isMarking}
                      onClick={() => onMarkDone(order)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )}
                </div>
              )}
              <p className="text-sm text-foreground/90 leading-snug whitespace-pre-wrap break-words">
                {stripLocationTag(order.message)}
              </p>
              {bill &&
                (() => {
                  return (
                    <div className="rounded-xl border border-brand-border bg-brand/5 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-brand">{s.bill_title}</p>
                        {billEdited && (
                          <button
                            type="button"
                            data-testid="my-orders-bill-edited-badge"
                            onClick={() => onOpenBillHistory(bill.id)}
                            className="text-xs font-semibold text-brand underline shrink-0"
                          >
                            {s.bill_editedBadge}
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        {bill.items.map((item, i) => (
                          <div
                            key={i}
                            className="flex justify-between text-xs text-foreground"
                          >
                            <span>
                              {item.description}{" "}
                              {item.quantity > 1
                                ? `×${item.quantity}${item.unit ? item.unit : ""}`
                                : ""}
                            </span>
                            <span>₹{(item.total_price ?? item.quantity * item.unit_price).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-brand-border pt-1 flex justify-between text-sm font-semibold">
                        <span>{s.bill_total}</span>
                        <span className="text-brand">₹{bill.total_amount.toFixed(2)}</span>
                      </div>
                      {bill.payment_status === "unpaid" &&
                        isBillPastPaymentHygieneTier1(bill.created_at, bill.payment_status) && (
                          <div
                            data-testid="my-orders-payment-hygiene-warning"
                            className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                          >
                            <p className="text-xs text-amber-400 text-center leading-snug">
                              {s.payment_hygiene_unpaid_warning}
                            </p>
                          </div>
                        )}
                      {order.payment_status === "claimed" && (
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />
                          {s.payment_claimed}
                        </div>
                      )}
                      {order.payment_status === "confirmed" && (
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
                          {s.payment_confirmed}
                        </div>
                      )}
                      {order.payment_status === "disputed" && (
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
                          {s.payment_disputed}
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {bill.payment_mode === "cash"
                            ? s.bill_cash
                            : bill.payment_mode === "upi"
                              ? s.bill_upi
                              : s.bill_khata}
                          {" · "}
                          {bill.payment_status === "paid" ? s.bill_statusPaid : s.bill_statusUnpaid}
                        </span>
                        <div className="flex items-center gap-2">
                          {order.vendors?.phone?.trim() && (
                            <button
                              type="button"
                              onClick={() => onHelpVendorCall(order)}
                              className="text-xs text-brand font-semibold border border-brand/40 rounded-lg px-3 py-1"
                            >
                              {s.ai_bridge_call_now}
                            </button>
                          )}
                          {canCustomerSelfDeclarePayment(order, bill, paymentSelfDeclareRestricted) ? (
                            <button
                              type="button"
                              data-testid="my-orders-pay-now-btn"
                              disabled={paymentSheetLoading}
                              className="text-xs text-amber-500 font-semibold border border-amber-500/50 rounded-lg px-3 py-1 disabled:opacity-50 inline-flex items-center gap-1.5"
                              onClick={() => onOpenPayment(order, bill)}
                            >
                              {paymentSheetLoading ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              {s.payment_pay_now}
                            </button>
                          ) : isCustomerSelfDeclarePaymentEligible(order, bill) &&
                            paymentSelfDeclareRestricted ? (
                            isPaymentBlockRequest ? (
                              <span
                                data-testid="my-orders-payment-restricted-blocking-bill"
                                className="text-xs text-amber-700 dark:text-amber-400 max-w-[14rem] text-right leading-snug"
                              >
                                {s.payment_restricted_blocking_bill_resolve(
                                  order.vendors?.shop_name?.trim() || s.myOrders_shopFallback,
                                )}
                              </span>
                            ) : (
                              <span
                                data-testid="my-orders-payment-cash-only"
                                className="text-xs text-amber-700 dark:text-amber-400 max-w-[14rem] text-right leading-snug"
                              >
                                {s.payment_cash_only_restricted}
                              </span>
                            )
                          ) : bill.payment_status === "unpaid" ? (
                            <span
                              data-testid="my-orders-payment-awaiting-vendor"
                              className="text-xs text-muted-foreground"
                            >
                              {s.payment_awaiting_vendor_confirm}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {bill.notes && (
                        <p className="text-xs text-muted-foreground italic">{bill.notes}</p>
                      )}
                    </div>
                  );
                })()}
              {(order.status === "fulfilled" || order.status === "done") &&
                review &&
                (() => {
                  const canEdit =
                    Date.now() - new Date(review.created_at).getTime() < 7 * 24 * 60 * 60 * 1000;
                  return (
                    <div className="rounded-xl border border-surface-border bg-surface/50 px-3 py-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs">
                          {"⭐".repeat(review.rating)}
                          {"☆".repeat(5 - review.rating)}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() =>
                              onEditReview({
                                id: review.id,
                                vendorId: order.vendor_id,
                                rating: review.rating,
                                text: review.review_text ?? "",
                              })
                            }
                            className="text-xs text-brand font-semibold"
                          >
                            {s.review_edit}
                          </button>
                        )}
                      </div>
                      {review.review_text && (
                        <p className="text-xs text-muted-foreground">
                          &quot;{review.review_text}&quot;
                        </p>
                      )}
                      {review.vendor_response && (
                        <div className="rounded-lg bg-brand/5 border border-brand-border px-2 py-1.5">
                          <p className="text-xs text-brand font-semibold">{s.review_vendorSays}</p>
                          <p className="text-xs text-foreground">{review.vendor_response}</p>
                          {review.vendor_responded_at && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {formatTimeAgo(review.vendor_responded_at)}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              {customerOrderShowsLiveLocation({
                id: order.id,
                status: order.status,
                created_at: order.created_at,
                delivery_slot: order.delivery_slot,
                appointment_time: order.appointment_time,
                appointment_status: order.appointment_status,
                service_mode: order.service_mode ?? order.vendors?.service_mode,
              }) &&
                (() => {
                  const live = vendorLive;
                  const distM =
                    live && userCoords
                      ? distanceMeters(
                          { lat: userCoords.lat, lng: userCoords.lng },
                          { lat: live.latitude, lng: live.longitude },
                        )
                      : null;
                  void locationTick;
                  const isHelpOrder =
                    String(order.service_mode ?? order.vendors?.service_mode ?? "")
                      .trim()
                      .toLowerCase() === "help";
                  return (
                    <>
                      {live && distM != null && (
                        <p className="text-xs text-brand">
                          📍 Vendor is {formatVendorDistance(distM)} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {!live && (
                        <p className="text-xs text-muted-foreground">📍 {s.vendor_distance}</p>
                      )}
                      {live && distM == null && (
                        <p className="text-xs text-brand">
                          📍 {s.vendor_distance} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {vendorStopped && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                          <p className="text-xs text-amber-400 text-center leading-snug">
                            {s.vendor_stopped_warning}
                          </p>
                          {order.vendors?.phone && (
                            <button
                              type="button"
                              onClick={() => onHelpVendorCall(order)}
                              className="w-full rounded-lg border border-brand/40 text-brand text-xs font-semibold py-2"
                            >
                              {s.radar_connect_ai}
                            </button>
                          )}
                        </div>
                      )}
                      {isHelpOrder &&
                        isHelpAcceptDelayedRow(order, helpAcceptTimeoutHours) && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                          <p className="text-xs text-amber-400 text-center leading-snug">
                            {formatHelpDelayedWarning(
                              s.order_help_delayed_warning,
                              helpAcceptTimeoutHours,
                            )}
                          </p>
                        </div>
                      )}
                    </>
                  );
                })()}
              {order.status === "cancelled" && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {/* cancel_reason is only recorded by vendor_cancel_order;
                        customer cancels (cancel_customer_order) never set it —
                        same origin discriminator as the status pill above. */}
                    {order.cancel_reason?.trim() || s.myOrders_youCancelledDefault}
                  </p>
                </div>
              )}
              {order.status === "expired" && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {s.myOrders_expiredBanner}
                  </p>
                </div>
              )}
              {(() => {
                const slot = deliverySlotLabel(order.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="mt-1 rounded-lg border border-brand-border bg-brand/5 px-3 py-2 text-xs">
                    {s.myOrders_deliverySlotPrefix}<span className="text-green-700 dark:text-brand font-semibold">{slot}</span>
                  </div>
                );
              })()}
              {order.appointment_time &&
                (() => {
                  const msg = order.message ?? "";
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
                    <div className={`mt-2 rounded-lg border px-3 py-2 text-xs space-y-0.5 ${borderColor}`}>
                      <div className={`font-semibold ${labelColor}`}>{locationLabel}</div>
                      <div>
                        {s.myOrders_apptAround}
                        <span className={`font-semibold ${timeColor}`}>
                          {new Date(order.appointment_time).toLocaleString("en-IN", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {order.appointment_status === "confirmed" &&
                            order.status !== "cancelled" &&
                            order.status !== "fulfilled" &&
                            order.status !== "done" &&
                            s.myOrders_apptConfirmed}
                          {order.appointment_status === "declined" && s.myOrders_apptDeclined}
                          {order.appointment_status === "cancelled" && s.myOrders_apptCancelled}
                          {order.appointment_status === "pending" && s.myOrders_apptAwaiting}
                        </span>
                      </div>
                    </div>
                  );
                })()}

              {(() => {
                const mapsUrl = resolveCustomerNavigateToVendorUrl(order);
                if (!mapsUrl) return null;
                return (
                  <button
                    type="button"
                    data-testid="myorders-open-maps-btn"
                    onClick={() => openGoogleMaps(mapsUrl)}
                    className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                  >
                    🗺️ {s.maps_openInMaps}
                  </button>
                );
              })()}

              {order.appointment_time &&
                order.status !== "fulfilled" &&
                order.status !== "done" &&
                order.status !== "cancelled" &&
                (() => {
                  if (
                    order.appointment_status === "declined" ||
                    order.appointment_status === "cancelled"
                  ) {
                    return (
                      <button
                        type="button"
                        onClick={() => onCancelAppointment(order)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_dismiss}
                      </button>
                    );
                  }

                  const appointmentDate = new Date(order.appointment_time);
                  const today = new Date();
                  const isSameDay = appointmentDate.toDateString() === today.toDateString();
                  const isPast = appointmentDate < today;

                  if (isPast) return null;

                  if (!isSameDay) {
                    return (
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        onClick={() => onSetShowCancelConfirm(true)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    );
                  }

                  if (!hasCalledVendor) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400 text-center">
                          {s.myOrders_sameDayWarning}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onHelpVendorCall(order);
                            onMarkCalledVendorSoon();
                          }}
                          className="w-full rounded-lg border border-brand/40 text-brand text-xs font-semibold py-2"
                        >
                          {s.myOrders_callThenCancel}
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400 text-center">
                        {s.myOrders_callDone}
                      </p>
                      {/* One-tap cancel after the call, without an extra confirmation
                          dialog, is a deliberate product decision — the call itself is
                          the confirmation step. Do not add friction here. */}
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        onClick={() => onCancelAppointment(order)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    </div>
                  );
                })()}

              {showCancelConfirm && order.status !== "cancelled" && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-xs text-destructive font-semibold text-center">
                    {s.myOrders_confirmCancelQ}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onCancelAppointment(order)}
                      className="rounded-lg bg-destructive text-white text-xs font-semibold py-2"
                    >
                      {s.myOrders_yesCancel}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetShowCancelConfirm(false)}
                      className="rounded-lg border border-border text-xs font-semibold py-2"
                    >
                      {s.myOrders_keepIt}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {order.status === "cancelled" || order.status === "expired" ? (
                  billBlocksDismiss(bill) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-xs text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={isMarking}
                      onClick={() => onMarkDone(order)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )
                ) : null}
                {order.status === "fulfilled" ? (
                  billBlocksDismiss(bill) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-xs text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : review ? (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={isMarking}
                      onClick={() => onMarkDone(order)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold h-10 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-rate-btn"
                      disabled={isMarking}
                      onClick={() => onFulfilledDismiss(order)}
                      className="w-full rounded-2xl bg-brand text-page-bg text-sm font-semibold h-12 active:scale-[0.99] disabled:opacity-50"
                    >
                      {isMarking
                        ? s.myOrders_saving
                        : fulfilledOrderCtaLabel(order.vendors?.service_mode, s)}
                    </button>
                  )
                ) : null}
                {order.status !== "cancelled" &&
                  !order.appointment_time &&
                  (canShowRemoveOrder(order) ? (
                    !showOrderCancelConfirm ? (
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        disabled={isMarking}
                        onClick={() => onSetShowOrderCancelConfirm(true)}
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
                            disabled={isMarking}
                            onClick={() => onRemoveOrder(order)}
                            className="rounded-lg bg-destructive text-white text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {s.myOrders_yesCancel}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSetShowOrderCancelConfirm(false)}
                            className="rounded-lg border border-border text-xs font-semibold py-2"
                          >
                            {s.myOrders_keepIt}
                          </button>
                        </div>
                      </div>
                    )
                  ) : order.status === "seen" &&
                    !canShowPreAcceptCancel(order) &&
                    orderCreatedWithinLast24h(order.created_at) ? (
                    <p className="text-xs text-muted-foreground text-center px-1">
                      {s.myOrders_cannotCancel}
                    </p>
                  ) : null)}
              </div>
            </li>
  );
}
