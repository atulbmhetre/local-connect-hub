import { invokeNotifyUser } from "@/lib/supabase";
import { strings, type Language } from "@/lib/strings";
import {
  hasSentIveStarted,
  iveStartedActionStartsTracking,
  markIveStartedSent,
  shouldShowIveStartedButton,
  type OrderTrackingSlice,
} from "@/lib/vendorTrackingPolicy";

function readLang(): Language {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    return stored === "hi" || stored === "mr" ? stored : "en";
  } catch {
    return "en";
  }
}

export type IveStartedResult =
  | { ok: true; alreadySent?: boolean }
  | { ok: false; reason: "not_eligible" | "no_phone" | "tracking_forbidden" };

/**
 * Cases 4 & 5 — one-time customer notification only.
 * Intentionally does not import or call vendorBackgroundLocation.
 */
export async function sendIveStartedCustomerNotification(opts: {
  order: OrderTrackingSlice;
  userPhone: string | null | undefined;
}): Promise<IveStartedResult> {
  // Compile-time + runtime guard: this action must never start tracking.
  if (iveStartedActionStartsTracking()) {
    return { ok: false, reason: "tracking_forbidden" };
  }

  if (hasSentIveStarted(opts.order.id)) {
    return { ok: true, alreadySent: true };
  }

  if (!shouldShowIveStartedButton(opts.order)) {
    return { ok: false, reason: "not_eligible" };
  }

  const phone = opts.userPhone?.trim();
  if (!phone) return { ok: false, reason: "no_phone" };

  const s = strings[readLang()];
  const isDelivery = Boolean(opts.order.delivery_slot) && !opts.order.appointment_time;
  invokeNotifyUser({
    user_phone: phone,
    title: isDelivery
      ? s.incoming_iveStarted_delivery_title
      : s.incoming_iveStarted_appointment_title,
    body: isDelivery
      ? s.incoming_iveStarted_delivery_body
      : s.incoming_iveStarted_appointment_body,
    type: "order_update",
    order_id: opts.order.id,
  });

  markIveStartedSent(opts.order.id);
  return { ok: true };
}
