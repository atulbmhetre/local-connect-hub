/**
 * Pure policy for the five approved vendor-location cases.
 * Case 4/5 must never start GPS tracking — enforced here and in callers.
 */

export type TrackingServiceMode = "help" | "delivery" | "appointment" | "booking" | string | null | undefined;

export type OrderTrackingSlice = {
  id: string;
  status: string;
  created_at?: string | null;
  delivery_slot?: string | null;
  appointment_time?: string | null;
  appointment_status?: string | null;
};

/** 400m — middle of the 300–500m band: fewer DB writes than 300, still useful for Radar/live-tracking. */
export const VENDOR_LOCATION_DISTANCE_FILTER_M = 400;

export function vendorOffersHelp(opts: {
  service_mode?: string | null;
  availability_modes?: readonly string[] | null;
}): boolean {
  const modes = opts.availability_modes ?? [];
  if (modes.some((m) => String(m).trim().toLowerCase() === "help")) return true;
  return String(opts.service_mode ?? "").trim().toLowerCase() === "help";
}

export function isInstantDeliveryOrder(order: Pick<OrderTrackingSlice, "delivery_slot">): boolean {
  return String(order.delivery_slot ?? "").trim().toLowerCase() === "asap";
}

export function isScheduledDeliveryOrder(order: Pick<OrderTrackingSlice, "delivery_slot">): boolean {
  const slot = String(order.delivery_slot ?? "").trim().toLowerCase();
  return slot.length > 0 && slot !== "asap";
}

/**
 * Instant appointments stamp appointment_time via getDeliverySlotDeadline("asap")
 * (= created_at + ~2h). Scheduled picks use an arbitrary future datetime.
 */
export function isInstantAppointmentOrder(
  order: Pick<OrderTrackingSlice, "appointment_time" | "created_at">,
): boolean {
  if (!order.appointment_time || !order.created_at) return false;
  const created = new Date(order.created_at).getTime();
  const appt = new Date(order.appointment_time).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(appt)) return false;
  const deltaFromPlus2h = Math.abs(appt - created - 2 * 60 * 60 * 1000);
  return deltaFromPlus2h <= 15 * 60 * 1000;
}

export function isScheduledAppointmentOrder(
  order: Pick<OrderTrackingSlice, "appointment_time" | "created_at">,
): boolean {
  if (!order.appointment_time) return false;
  return !isInstantAppointmentOrder(order);
}

/** Cases 2 & 3 — start watcher on accept/confirm of an instant Booking/Delivery order. */
export function shouldStartTrackingOnOrderAccept(order: OrderTrackingSlice): boolean {
  if (order.appointment_time) {
    return isInstantAppointmentOrder(order);
  }
  if (order.delivery_slot) {
    return isInstantDeliveryOrder(order);
  }
  // Help orders use Go-Live continuous tracking (case 1), not order-scoped.
  return false;
}

/** Cases 4 & 5 — "I've Started" button; also Help accepted (cancel gate signal). */
export function shouldShowIveStartedButton(order: OrderTrackingSlice): boolean {
  const status = String(order.status ?? "").toLowerCase();
  if (status === "fulfilled" || status === "done" || status === "cancelled") return false;

  if (order.appointment_time) {
    if (String(order.appointment_status ?? "").toLowerCase() !== "confirmed") return false;
    if (status !== "accepted") return false;
    return isScheduledAppointmentOrder(order);
  }

  if (order.delivery_slot) {
    if (status !== "accepted") return false;
    return isScheduledDeliveryOrder(order);
  }

  // Help: no slot — button records vendor_started_at for customer cancel gate.
  return status === "accepted";
}

/**
 * Hard guarantee for cases 4 & 5: tapping "I've Started" must not start tracking.
 * Callers and tests rely on this returning false forever.
 */
export function iveStartedActionStartsTracking(): false {
  return false;
}

export function shouldRestoreOrderTracking(order: OrderTrackingSlice): boolean {
  const status = String(order.status ?? "").toLowerCase();
  if (status !== "accepted") return false;
  if (order.appointment_time) {
    if (String(order.appointment_status ?? "").toLowerCase() === "cancelled") return false;
    return isInstantAppointmentOrder(order);
  }
  if (order.delivery_slot) {
    return isInstantDeliveryOrder(order);
  }
  return false;
}

/**
 * Customer live-location surfaces (Home stale banner, My Orders distance/stopped):
 * Help accepted continuously; instant Delivery/Appointment while accepted;
 * scheduled Delivery/Appointment never.
 */
export function customerOrderShowsLiveLocation(
  order: OrderTrackingSlice & { service_mode?: string | null },
): boolean {
  if (String(order.status ?? "").toLowerCase() !== "accepted") return false;
  const mode = String(order.service_mode ?? "").trim().toLowerCase();
  if (mode === "help") return true;
  if (mode === "delivery" || mode === "appointment") {
    return shouldRestoreOrderTracking(order);
  }
  // Mode unknown: only slot/time signals (same as Capgo order-scoped restore).
  return shouldRestoreOrderTracking(order);
}

export const IVE_STARTED_STORAGE_PREFIX = "aaspaas:ive_started:";

export function iveStartedStorageKey(orderId: string): string {
  return `${IVE_STARTED_STORAGE_PREFIX}${orderId}`;
}

export function hasSentIveStarted(orderId: string): boolean {
  try {
    return localStorage.getItem(iveStartedStorageKey(orderId)) === "1";
  } catch {
    return false;
  }
}

export function markIveStartedSent(orderId: string): void {
  try {
    localStorage.setItem(iveStartedStorageKey(orderId), "1");
  } catch {
    /* ignore */
  }
}
