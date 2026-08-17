import { invokeNotifyUser, supabase } from "@/lib/supabase";
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
  | { ok: false; reason: "not_eligible" | "no_phone" | "tracking_forbidden" | "persist_failed" };

/**
 * One-time customer notification + persist vendor_started_at for cancel gates.
 * Intentionally does not start GPS tracking.
 */
export async function sendIveStartedCustomerNotification(opts: {
  order: OrderTrackingSlice;
  userPhone: string | null | undefined;
  vendorId: string;
  vendorPhone: string;
}): Promise<IveStartedResult> {
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

  const { error: persistError } = await supabase.rpc("mark_vendor_order_started", {
    p_request_id: opts.order.id,
    p_vendor_id: opts.vendorId,
    p_vendor_phone: opts.vendorPhone,
  });
  if (persistError) {
    return { ok: false, reason: "persist_failed" };
  }

  const s = strings[readLang()];
  const isDelivery = Boolean(opts.order.delivery_slot) && !opts.order.appointment_time;
  const isHelp =
    !opts.order.delivery_slot &&
    !(opts.order.appointment_time != null && String(opts.order.appointment_time).trim() !== "");
  invokeNotifyUser({
    user_phone: phone,
    title: isDelivery
      ? s.incoming_iveStarted_delivery_title
      : isHelp
        ? s.incoming_iveStarted_help_title
        : s.incoming_iveStarted_appointment_title,
    body: isDelivery
      ? s.incoming_iveStarted_delivery_body
      : isHelp
        ? s.incoming_iveStarted_help_body
        : s.incoming_iveStarted_appointment_body,
    type: "order_update",
    order_id: opts.order.id,
  });

  markIveStartedSent(opts.order.id);
  return { ok: true };
}
