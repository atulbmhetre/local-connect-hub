import { supabase } from "@/lib/supabase";
import {
  hasSentIveStarted,
  iveStartedActionStartsTracking,
  markIveStartedSent,
  shouldShowIveStartedButton,
  type OrderTrackingSlice,
} from "@/lib/vendorTrackingPolicy";

export type IveStartedResult =
  | { ok: true; alreadySent?: boolean }
  | { ok: false; reason: "not_eligible" | "no_phone" | "tracking_forbidden" | "persist_failed" };

/**
 * Persist vendor_started_at for cancel gates. Customer "I've started" notify is
 * fired by DB trigger when vendor_started_at goes NULL→set.
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

  markIveStartedSent(opts.order.id);
  return { ok: true };
}
