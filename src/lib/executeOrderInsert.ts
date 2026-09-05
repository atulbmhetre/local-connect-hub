/**
 * Core Parchi order placement (create_customer_request / create_recurring_order).
 * Extracted from ParchiSheet — behavior must stay identical to the prior inline
 * `executeOrderInsert` (RPC payloads, gates, toasts, retries).
 */

import { toast } from "sonner";
import type { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";
import { supabase, upsertUser, incrementUserOrders } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { resolveHelpServiceLocation } from "@/lib/helpServiceLocation";
import {
  deliveryCartSubtotal,
  formatMinDeliveryOrderAmount,
  meetsMinDeliveryOrder,
} from "@/lib/deliveryMinOrder";
import {
  buildOrderPlacementFingerprint,
  clearOrderPlacementIdempotencyKey,
  getOrCreateOrderPlacementIdempotencyKey,
} from "@/lib/orderPlacementIdempotency";
import {
  DELIVERY_ASAP_OFFSET_MS,
  getDeliverySlotDeadline,
} from "@/lib/deliverySlotDeadline";
import { captureError } from "@/lib/sentry";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";

export type ParchiVendorMenuItem = {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  unit?: string | null;
  is_available: boolean;
  category_id?: string | null;
  image_url?: string | null;
};

export type ExecuteOrderInsertTrustBlock = "banned" | "suspended" | "payment_block" | null;

type ParchiStrings = typeof strings.en;

export const menuItemLabel = (item: ParchiVendorMenuItem) =>
  item.name?.trim() || item.description?.trim() || "Item";

export function buildStructuredItemsFrom(
  selected: Record<string, number>,
  catalog: ParchiVendorMenuItem[],
) {
  const items = Object.entries(selected)
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => {
      const item = catalog.find((m) => m.id === id);
      if (!item) return null;
      return {
        item_id: item.id,
        name: menuItemLabel(item),
        quantity: qty,
        unit_price: item.price,
        unit: item.unit || null,
      };
    })
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export type ExecuteOrderInsertParams = {
  phone: string;
  vendor: Vendor;
  message: string;
  resolvedServiceMode: string;
  isHelpMode: boolean;
  isDeliveryMode: boolean;
  isAppointmentMode: boolean;
  showRecurrence: boolean;
  appointmentLocation: "home" | "shop" | "decide";
  helpLocation: "home" | "shop" | null;
  appointmentTiming: "instant" | "scheduled";
  appointmentDate: string;
  appointmentTime: string;
  deliverySlot: string;
  recurrenceKind: "one_time" | "daily" | "weekly" | "custom";
  recurrenceCustomDays: string;
  selectedAddressId: string | null;
  addresses: { id: string; address_text: string }[];
  newAddress: string;
  saveAddress: boolean;
  customerLat: number | null;
  customerLng: number | null;
  canServeAtCustomer: boolean;
  canServeAtVendor: boolean;
  selectedMenuItems: Record<string, number>;
  menuItems: ParchiVendorMenuItem[];
  minDeliveryOrderAmount: number | null;
  orderCategoryId: string | null;
  maxOrderMessageChars: number;
  s: ParchiStrings;
};

export type ExecuteOrderInsertEffects = {
  setSending: (value: boolean) => void;
  setOfflineApptError: (value: boolean) => void;
  setTrustBlock: (value: ExecuteOrderInsertTrustBlock) => void;
  setMessage: (value: string) => void;
  setSelectedMenuItems: (value: Record<string, number>) => void;
  setPendingPhone: (value: string | null) => void;
  onOrderSent?: () => void;
  onClose: () => void;
  fetchPaymentBlockStatus: (phone: string, deviceId: string) => void | Promise<unknown>;
  /**
   * Network-exhausted toast retry. Prefer re-entering the caller so menu refs /
   * form state are re-read (same as prior `() => void executeOrderInsert(phone)`).
   */
  scheduleNetworkRetry?: () => void;
};

/**
 * Place a customer order / booking / recurring order for `phone`.
 * Callers must set `sending` already if they need the trust→insert gap covered;
 * this always sets sending true on entry and clears it in `finally`.
 */
export async function executeOrderInsert(
  params: ExecuteOrderInsertParams,
  effects: ExecuteOrderInsertEffects,
): Promise<void> {
  const {
    phone,
    vendor: v,
    message,
    resolvedServiceMode,
    isHelpMode,
    isDeliveryMode,
    isAppointmentMode,
    showRecurrence,
    appointmentLocation,
    helpLocation,
    appointmentTiming,
    appointmentDate,
    appointmentTime,
    deliverySlot,
    recurrenceKind,
    recurrenceCustomDays,
    selectedAddressId,
    addresses,
    newAddress,
    saveAddress,
    customerLat,
    customerLng,
    canServeAtCustomer,
    canServeAtVendor,
    selectedMenuItems,
    menuItems,
    minDeliveryOrderAmount,
    orderCategoryId,
    maxOrderMessageChars,
    s,
  } = params;

  const {
    setSending,
    setOfflineApptError,
    setTrustBlock,
    setMessage,
    setSelectedMenuItems,
    setPendingPhone,
    onOrderSent,
    onClose,
    fetchPaymentBlockStatus,
  } = effects;

  // Hold disabled from first entry through RPC completion so trust→insert
  // cannot double-submit (caller may already have set sending during trust).
  setSending(true);
  try {
    const text = message.trim();
    const needsAddress =
      resolvedServiceMode === "delivery" ||
      (resolvedServiceMode === "appointment" && appointmentLocation === "home");
    const finalAddress = needsAddress
      ? selectedAddressId
        ? (addresses.find((a) => a.id === selectedAddressId)?.address_text ?? "")
        : newAddress.trim()
      : null;
    const locationNote =
      resolvedServiceMode === "appointment"
        ? appointmentLocation === "home"
          ? s.parchi_locationComeToMe
          : appointmentLocation === "shop"
            ? s.parchi_locationVisitShop
            : s.parchi_locationTbd
        : isHelpMode && helpLocation === "home"
          ? s.parchi_locationComeToMe
          : isHelpMode && helpLocation === "shop"
            ? s.parchi_locationVisitShop
            : "";
    const isInstantAppointment =
      isAppointmentMode && appointmentTiming === "instant" && v.is_active === true;
    const appointmentTimestamp = isInstantAppointment
      ? getDeliverySlotDeadline("asap")
      : isAppointmentMode && appointmentDate && appointmentTime
        ? new Date(`${appointmentDate}T${appointmentTime}:00`).toISOString()
        : null;
    const selectedSlot = isDeliveryMode ? deliverySlot : null;

    if (isDeliveryMode) {
      if (selectedSlot === "asap" && v.is_active !== true) {
        toast.error(s.parchi_errVendorNotLiveAsap);
        return;
      }
      const slotDeadline = getDeliverySlotDeadline(selectedSlot);
      if (slotDeadline != null && new Date(slotDeadline) < new Date()) {
        toast.error(s.parchi_slot_expired);
        return;
      }
    }

    if (isAppointmentMode) {
      if (!isInstantAppointment && appointmentTimestamp == null) {
        toast.error(s.parchi_errNoDateTime);
        return;
      }
      if (appointmentTimestamp != null && new Date(appointmentTimestamp) < new Date()) {
        toast.error(s.parchi_appointment_expired);
        return;
      }
      if (
        !isInstantAppointment &&
        v.is_active === false &&
        appointmentTimestamp != null &&
        new Date(appointmentTimestamp).getTime() - Date.now() < DELIVERY_ASAP_OFFSET_MS
      ) {
        setOfflineApptError(true);
        return;
      }
    }

    const serviceLocation = isHelpMode
      ? resolveHelpServiceLocation(helpLocation, {
          canServeAtCustomer,
          canServeAtVendor,
        })
      : null;

    const device_id = getDeviceId();
    const structuredItems = buildStructuredItemsFrom(selectedMenuItems, menuItems);
    if (isDeliveryMode) {
      const min = formatMinDeliveryOrderAmount(
        minDeliveryOrderAmount ?? v.min_delivery_order_amount,
      );
      const subtotal = deliveryCartSubtotal(selectedMenuItems, menuItems);
      if (!meetsMinDeliveryOrder(subtotal, min)) {
        toast.error(
          s.parchi_min_delivery_need
            .replace("{min}", String(min ?? 0))
            .replace("{short}", String(Math.max(0, Math.ceil((min ?? 0) - subtotal)))),
        );
        return;
      }
    }
    const wantsRecurring = showRecurrence && recurrenceKind !== "one_time";
    const customDays = Number.parseInt(recurrenceCustomDays, 10);
    if (wantsRecurring && recurrenceKind === "custom") {
      if (!Number.isFinite(customDays) || customDays < 2 || customDays > 30) {
        toast.error(s.parchi_recurrence_custom_days);
        return;
      }
    }

    const messageForRpc = text.slice(0, maxOrderMessageChars) + locationNote;
    const recurrenceKindForKey = wantsRecurring ? recurrenceKind : "one_time";
    const fingerprint = buildOrderPlacementFingerprint({
      vendorId: v.id,
      phone,
      message: messageForRpc,
      serviceMode: resolvedServiceMode,
      deliverySlot: selectedSlot,
      appointmentTimestamp,
      appointmentInstant: isInstantAppointment,
      address: finalAddress,
      itemsJson: JSON.stringify(structuredItems),
      recurrenceKind: recurrenceKindForKey,
      recurrenceCustomDays: wantsRecurring && recurrenceKind === "custom" ? recurrenceCustomDays : "",
      serviceLocation,
    });
    // Persist across withNetworkRetry and user Retry toast; clear only on
    // confirmed success or sheet cancel (not on NetworkExhaustedError).
    const clientIdempotencyKey = getOrCreateOrderPlacementIdempotencyKey(v.id, fingerprint);
    const orderPayload = {
      p_device_id: device_id,
      p_vendor_id: v.id,
      p_message: messageForRpc,
      p_user_phone: phone,
      p_device_id_log: device_id,
      p_delivery_address: finalAddress,
      p_delivery_slot: selectedSlot,
      p_delivery_slot_deadline:
        resolvedServiceMode === "delivery" ? getDeliverySlotDeadline(selectedSlot) : null,
      p_appointment_time: appointmentTimestamp,
      p_appointment_status: appointmentTimestamp ? "pending" : null,
      p_customer_latitude: customerLat ?? null,
      p_customer_longitude: customerLng ?? null,
      p_appointment_instant: isInstantAppointment,
      p_category_id: orderCategoryId ?? null,
      p_service_mode: resolvedServiceMode,
      p_items: structuredItems,
      p_service_location: serviceLocation,
      p_client_idempotency_key: clientIdempotencyKey,
    };

    const { error } = await withNetworkRetry(
      async () =>
        throwOnSupabaseNetworkError(
          wantsRecurring
            ? await supabase.rpc("create_recurring_order", {
                ...orderPayload,
                p_interval_kind: recurrenceKind,
                p_interval_days: recurrenceKind === "custom" ? customDays : null,
              })
            : await supabase.rpc("create_customer_request", orderPayload),
        ),
      {
        onRetrying: () => {
          showNetworkRetryingToast({ retrying: s.network_retrying });
        },
        shouldRetry: () => getNavigatorOnline(),
      },
    );
    dismissNetworkRetryingToast();
    if (error) {
      captureError(error, {
        scope: "parchiSheet.createCustomerRequest",
        vendorId: v.id,
        serviceMode: resolvedServiceMode,
      });
      const msg = error.message ?? "";
      if (msg.includes("vendor_not_live_for_asap") || msg.includes("vendor_not_live_for_instant")) {
        toast.error(s.parchi_errVendorNotLiveAsap);
      } else if (msg.includes("below_min_delivery_order")) {
        toast.error(s.parchi_errBelowMinDelivery);
      } else if (msg.includes("customer_banned")) {
        setTrustBlock("banned");
      } else if (msg.includes("customer_payment_block")) {
        void fetchPaymentBlockStatus(phone, getDeviceId());
      } else if (msg.includes("vendor_banned") || msg.includes("vendor_not_discoverable")) {
        toast.error(s.parchi_errCouldNotSend, { description: error.message });
      } else {
        toast.error(s.parchi_errCouldNotSend, { description: error.message });
      }
      return;
    }
    clearOrderPlacementIdempotencyKey(v.id);
    void upsertUser(phone);
    void incrementUserOrders(phone);
    // Vendor new_order notify is server-triggered (request_after_insert_notify_vendor).
    if (saveAddress && newAddress.trim()) {
      const { error: addrError } = await supabase.rpc("insert_user_address", {
        p_device_id: getDeviceId(),
        p_user_phone: getUserPhone() ?? null,
        p_label: "",
        p_address_text: newAddress.trim(),
        p_is_default: addresses.length === 0,
      });
      if (addrError) {
        captureError(addrError, { scope: "parchiSheet.saveAddress" });
        console.error("Address save failed:", addrError.message);
      }
    }
    toast.success(
      isAppointmentMode ? s.parchi_toastBookingSuccess : s.parchi_toastOrderSuccess,
    );
    try {
      sessionStorage.setItem(`aaspaas:parchi:${v.id}`, "1");
    } catch {
      /* ignore */
    }
    setMessage("");
    setSelectedMenuItems({});
    setPendingPhone(null);
    onOrderSent?.();
    onClose();
  } catch (err) {
    dismissNetworkRetryingToast();
    if (err instanceof NetworkExhaustedError) {
      // Keep placement idempotency key so Retry reuses it.
      showNetworkFailedToast(
        () => {
          if (effects.scheduleNetworkRetry) {
            effects.scheduleNetworkRetry();
          } else {
            void executeOrderInsert(params, effects);
          }
        },
        {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        },
      );
    } else {
      throw err;
    }
  } finally {
    setSending(false);
  }
}
