/**
 * Customer cancel gates for accepted Help / Delivery orders.
 * Appointment cancel stays on dismiss_order (unchanged).
 */

export type CustomerCancelOrderSlice = {
  id?: string;
  status: string;
  service_mode?: string | null;
  delivery_slot?: string | null;
  delivery_slot_deadline?: string | null;
  appointment_time?: string | null;
  vendor_started_at?: string | null;
  created_at?: string | null;
  vendors?: { service_mode?: string | null } | null;
};

/** Mirrors ParchiSheet getDeliverySlotDeadline ends → window open. */
export function getDeliverySlotWindowStart(
  slot: string | null | undefined,
  deadlineIso: string | null | undefined,
): Date | null {
  const s = String(slot ?? "")
    .trim()
    .toLowerCase();
  if (!s || s === "asap") return null;
  if (deadlineIso == null || String(deadlineIso).trim() === "") return null;
  const deadline = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadline)) return null;
  if (s === "tomorrow") return new Date(deadline - 20 * 60 * 60 * 1000);
  // morning / afternoon / evening (and unknown scheduled): end − 4h
  return new Date(deadline - 4 * 60 * 60 * 1000);
}

export function resolveOrderServiceMode(r: CustomerCancelOrderSlice): string {
  return String(r.service_mode ?? r.vendors?.service_mode ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Pre-accept cancel (sent / stale seen) — unchanged from canShowRemoveOrder.
 */
export function canShowPreAcceptCancel(
  r: Pick<CustomerCancelOrderSlice, "status" | "created_at">,
  nowMs: number = Date.now(),
): boolean {
  if (r.status === "sent") return true;
  if (r.status === "seen") {
    const t = new Date(r.created_at ?? "").getTime();
    if (!Number.isFinite(t)) return false;
    return nowMs - t >= 24 * 60 * 60 * 1000;
  }
  return false;
}

export type AcceptedCancelDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether customer may cancel an accepted Help/Delivery order (client mirror of RPC).
 */
export function canCancelAcceptedOrder(
  r: CustomerCancelOrderSlice,
  nowMs: number = Date.now(),
): AcceptedCancelDecision {
  if (String(r.status).toLowerCase() !== "accepted") {
    return { allowed: false, reason: "not_accepted" };
  }
  if (r.appointment_time != null && String(r.appointment_time).trim() !== "") {
    return { allowed: false, reason: "appointment_use_dismiss" };
  }

  const mode = resolveOrderServiceMode(r);
  if (mode === "help") {
    if (r.vendor_started_at != null && String(r.vendor_started_at).trim() !== "") {
      return { allowed: false, reason: "vendor_started" };
    }
    return { allowed: true };
  }

  if (mode === "delivery") {
    const slot = String(r.delivery_slot ?? "")
      .trim()
      .toLowerCase();
    if (slot === "asap") {
      return { allowed: false, reason: "asap_accepted" };
    }
    const start = getDeliverySlotWindowStart(r.delivery_slot, r.delivery_slot_deadline);
    if (start == null || nowMs >= start.getTime()) {
      return { allowed: false, reason: "window_started" };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: "unsupported_mode" };
}

/** Footer / banner: show Cancel Order for this row. */
export function canShowCustomerCancelOrder(
  r: CustomerCancelOrderSlice,
  nowMs: number = Date.now(),
): boolean {
  if (r.appointment_time != null && String(r.appointment_time).trim() !== "") {
    return false;
  }
  if (canShowPreAcceptCancel(r, nowMs)) return true;
  return canCancelAcceptedOrder(r, nowMs).allowed;
}

/**
 * Overdue / terminal Dismiss: only when cancel is not available.
 * Unpaid bill alone does not force Cancel if gates already closed.
 */
export function shouldShowDismissInsteadOfCancel(
  r: CustomerCancelOrderSlice,
  opts?: { hasUnpaidBill?: boolean; nowMs?: number },
): boolean {
  const nowMs = opts?.nowMs ?? Date.now();
  if (canShowCustomerCancelOrder(r, nowMs)) return false;
  return true;
}
