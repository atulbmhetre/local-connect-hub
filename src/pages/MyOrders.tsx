import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  supabase,
  invokeNotifyVendor,
  distanceMeters,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} from "@/lib/supabase";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { getVoiceLang } from "@/lib/voiceUtils";
import { ensureVoiceMicrophone } from "@/lib/nativePermissions";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { fetchVendorsVisibleToCustomer } from "@/lib/vendorRead";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { RatingSheet } from "@/components/RatingSheet";
import { PaymentSheet } from "@/components/PaymentSheet";
import { ArrowLeft, Loader2, Mic, Camera, Loader2 as Loader2Icon, Pencil, PhoneCall, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { isHelpAcceptDelayed, formatHelpDelayedWarning } from "@/lib/orderHelpDelay";
import { customerOrderShowsLiveLocation } from "@/lib/vendorTrackingPolicy";
import {
  canShowCustomerCancelOrder,
  canShowPreAcceptCancel,
} from "@/lib/customerCancelPolicy";
import { billBlocksDismiss } from "@/lib/dismissBillGate";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  SettingsPageHeader,
  SettingsSectionLabel,
  SettingsCard,
} from "@/components/settings/SettingsSection";
import { NotificationBell } from "@/components/NotificationBell";
import { Badge } from "@/components/ui/badge";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";
import {
  currentCycleTransactions,
  filterKhataLedgerByOutstanding,
  formatKhataBalanceDisplay,
  formatKhataDate,
  khataPaymentModeLabel,
} from "@/lib/khataDisplay";
import { KhataTxSourceChip } from "@/components/KhataTxSourceChip";
import { syncVendorRatingFromReviews } from "@/lib/vendorRating";
import { openGoogleMaps, resolveCustomerNavigateToVendorUrl } from "@/lib/mapsDeepLink";
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
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import { BillEditHistorySheet } from "@/components/BillEditHistorySheet";
import { captureError } from "@/lib/sentry";
import {
  isMyOrdersOverlayBlockingAutoRating,
  resolveAutoRatingAction,
  shouldDeferAutoRatingForUnpaidPayNow,
} from "@/lib/myOrdersAutoRating";
import {
  canCustomerSelfDeclarePayment,
  isCustomerSelfDeclarePaymentEligible,
} from "@/lib/customerPaymentGate";
import { isBillPastPaymentHygieneTier1 } from "@/lib/paymentHygiene";
const MAX_LEN = 200;

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

type RowWithShop = OrderRequestRow & {
  vendors: {
    shop_name: string;
    service_mode: string | null;
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  payment_status?: string;
};

type OrderBill = {
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

type VendorLocationPoint = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

type VendorLiveLocation = {
  latitude: number;
  longitude: number;
  lastUpdated: string;
};

function telHref(phone: string) {
  return `tel:${phone.replace(/[\s-]/g, "").trim()}`;
}

function formatVendorDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} mtr away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

function maxSpreadMeters(points: Pick<VendorLocationPoint, "latitude" | "longitude">[]): number {
  if (points.length < 2) return 0;
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(
        max,
        distanceMeters(
          { lat: points[i].latitude, lng: points[i].longitude },
          { lat: points[j].latitude, lng: points[j].longitude },
        ),
      );
    }
  }
  return max;
}

function computeVendorStopped(
  history: VendorLocationPoint[],
  stoppedRadiusM: number,
  stoppedMinutes: number,
): boolean {
  const cutoff = Date.now() - stoppedMinutes * 60 * 1000;
  const recent = history.filter((p) => p.timestamp >= cutoff);
  if (recent.length < 2) return false;

  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const movedSincePrev = distanceMeters(
    { lat: prev.latitude, lng: prev.longitude },
    { lat: last.latitude, lng: last.longitude },
  );
  if (movedSincePrev > stoppedRadiusM) return false;

  return maxSpreadMeters(recent) <= stoppedRadiusM;
}

function isVendorStoppedIncludingStale(
  history: VendorLocationPoint[],
  stoppedRadiusM: number,
  stoppedMinutes: number,
): boolean {
  if (computeVendorStopped(history, stoppedRadiusM, stoppedMinutes)) return true;
  if (history.length < 1) return false;
  const last = history[history.length - 1];
  return Date.now() - last.timestamp >= stoppedMinutes * 60 * 1000;
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

export function wasOrderEngaged(r: Pick<RowWithShop, "status" | "appointment_status">): boolean {
  return (
    r.status === "accepted" ||
    r.status === "fulfilled" ||
    r.appointment_status === "confirmed"
  );
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

function extractLocationTag(message: string): string {
  const m = message.match(/\s*(\[Come to my place\]|\[I'll visit your shop\]|\[Location TBD\])/);
  return m ? m[1] : "";
}

function buildMessageWithTags(base: string, original: string): string {
  const loc = extractLocationTag(original);
  const suffix = loc ? ` ${loc}` : "";
  return base.slice(0, MAX_LEN) + suffix;
}

function deliverySlotLabel(
  slot: string | null | undefined,
  labels: Record<string, string>,
): string | null {
  if (!slot?.trim()) return null;
  return labels[slot.trim().toLowerCase()] ?? slot;
}

type LocationHighlightState = { highlightOrderId?: string };

const MyOrders = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const highlightOrderId = (location.state as LocationHighlightState | null)?.highlightOrderId;
  const [flashOrderId, setFlashOrderId] = useState<string | null>(null);
  const { s } = useLanguage();
  const { config } = useAppConfig();
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
  const [rows, setRows] = useState<RowWithShop[]>([]);
  const [recurringOrders, setRecurringOrders] = useState<
    {
      id: string;
      vendor_id: string;
      shop_name: string | null;
      category_label: string | null;
      service_mode: string;
      interval_kind: string;
      interval_days: number;
      status: string;
      delivery_slot: string | null;
      next_run_at: string;
    }[]
  >([]);
  const [recurringActionId, setRecurringActionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [billsByRequestId, setBillsByRequestId] = useState<Record<string, OrderBill>>({});
  const [billsLoaded, setBillsLoaded] = useState(false);
  const [editedBillIds, setEditedBillIds] = useState<Set<string>>(() => new Set());
  const [historyBillId, setHistoryBillId] = useState<string | null>(null);
  const [myReviews, setMyReviews] = useState<
    Record<
      string,
      {
        id: string;
        rating: number;
        review_text: string | null;
        created_at: string;
        vendor_response: string | null;
        vendor_responded_at: string | null;
      }
    >
  >({});
  const [editingReview, setEditingReview] = useState<{
    id: string;
    vendorId: string;
    rating: number;
    text: string;
  } | null>(null);
  const [myKhata, setMyKhata] = useState<
    { vendor_id: string; shop_name: string; total_outstanding: number }[]
  >([]);
  const [khataDetail, setKhataDetail] = useState<{
    vendor_id: string;
    shop_name: string;
    total_outstanding: number;
  } | null>(null);
  const [khataTransactions, setKhataTransactions] = useState<
    {
      id: string;
      amount: number;
      note: string | null;
      payment_mode: string;
      created_at: string;
      request_id?: string | null;
      category_id?: string | null;
      category_label?: string | null;
      category_emoji?: string | null;
    }[]
  >([]);
  const [khataTxLoading, setKhataTxLoading] = useState(false);
  const [khataTxNetworkStatus, setKhataTxNetworkStatus] = useState<
    "retrying" | "failed" | null
  >(null);
  const khataDetailRetryRef = useRef<{
    vendor_id: string;
    shop_name: string;
    total_outstanding: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkLoadStatus, setNetworkLoadStatus] = useState<"retrying" | "failed" | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const rowActionLockRef = useRef(new Set<string>());
  const savingEditLockRef = useRef(false);
  const [ratingSheetOpen, setRatingSheetOpen] = useState(false);
  const [ratingVendor, setRatingVendor] = useState<{
    vendorId: string;
    shopName: string;
    serviceMode: string;
    vendorPhone: string | null;
  } | null>(null);
  const [pendingDismissId, setPendingDismissId] = useState<string | null>(null);
  const [ratingRequestId, setRatingRequestId] = useState<string | null>(null);
  const [calledVendor, setCalledVendor] = useState<Record<string, boolean>>({});
  // Track which orders have already auto-shown rating sheet to prevent re-triggering
  const [autoShownReviews, setAutoShownReviews] = useState<Set<string>>(new Set());
  const [showCancelConfirm, setShowCancelConfirm] = useState<Record<string, boolean>>({});
  const [showOrderCancelConfirm, setShowOrderCancelConfirm] = useState<Record<string, boolean>>({});
  const [editOrder, setEditOrder] = useState<RowWithShop | null>(null);
  const [editMessage, setEditMessage] = useState("");
  const [isListeningEdit, setIsListeningEdit] = useState(false);
  const [isProcessingImageEdit, setIsProcessingImageEdit] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [vendorLiveById, setVendorLiveById] = useState<Record<string, VendorLiveLocation>>({});
  const [vendorStoppedByOrderId, setVendorStoppedByOrderId] = useState<Record<string, boolean>>({});
  const [locationTick, setLocationTick] = useState(0);
  const [helpCallVendor, setHelpCallVendor] = useState<{
    vendor: AiBridgeVendor;
    userNeed: string;
    distanceKm: number | null;
    categoryId: string | null;
  } | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [paymentSheetOrder, setPaymentSheetOrder] = useState<null | {
    id: string;
    status: string;
    payment_status: string;
    amountRupees: number;
  }>(null);
  const [paymentSheetVendor, setPaymentSheetVendor] = useState<null | {
    vendor_id: string;
    shop_name: string;
    upi_id: string;
    phone: string;
    upi_qr_url: string | null;
    upi_qr_payee_id: string | null;
  }>(null);
  const [paymentSheetLoadingId, setPaymentSheetLoadingId] = useState<string | null>(null);
  const [paymentSelfDeclareRestricted, setPaymentSelfDeclareRestricted] = useState(false);
  const [paymentBlockRequestId, setPaymentBlockRequestId] = useState<string | null>(null);
  const mounted = useRef(true);
  const vendorLocationHistoryRef = useRef<Map<string, VendorLocationPoint[]>>(new Map());
  const pendingAutoRatingRef = useRef<RowWithShop | null>(null);
  const openedPaymentOrderIdsRef = useRef<Set<string>>(new Set());
  const autoShownReviewsRef = useRef(autoShownReviews);
  autoShownReviewsRef.current = autoShownReviews;
  const myReviewsRef = useRef(myReviews);
  myReviewsRef.current = myReviews;
  const billsByRequestIdRef = useRef(billsByRequestId);
  billsByRequestIdRef.current = billsByRequestId;
  const ratingOpenForIdRef = useRef<string | null>(null);
  ratingOpenForIdRef.current = ratingSheetOpen ? ratingRequestId : null;

  const consumeAutoRatingForOrder = useCallback((orderId: string) => {
    if (!orderId) return;
    pendingAutoRatingRef.current = null;
    setAutoShownReviews((prev) => {
      if (prev.has(orderId)) return prev;
      return new Set([...prev, orderId]);
    });
  }, []);
  const khataAllowAutoRatingRef = useRef(true);

  /** Help + instant Delivery/Appointment (accepted); scheduled never. */
  const acceptedHelpOrders = useMemo(
    () =>
      rows.filter((r) =>
        customerOrderShowsLiveLocation({
          id: r.id,
          status: r.status,
          created_at: r.created_at,
          delivery_slot: r.delivery_slot,
          appointment_time: r.appointment_time,
          appointment_status: r.appointment_status,
          service_mode: r.service_mode ?? r.vendors?.service_mode,
        }),
      ),
    [rows],
  );

  const acceptedHelpVendorIds = useMemo(
    () => [...new Set(acceptedHelpOrders.map((r) => r.vendor_id))],
    [acceptedHelpOrders],
  );

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase().trim();
    return rows.filter(
      (r) =>
        r.vendors?.shop_name?.toLowerCase().includes(q) ||
        r.message?.toLowerCase().includes(q) ||
        r.status?.toLowerCase().includes(q) ||
        r.delivery_address?.toLowerCase().includes(q) ||
        r.user_phone?.includes(q),
    );
  }, [rows, searchQuery]);

  useEffect(() => {
    if (!highlightOrderId || loading) return;
    const el = document.getElementById(`order-card-${highlightOrderId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashOrderId(highlightOrderId);
    const t = window.setTimeout(() => setFlashOrderId(null), 2000);
    return () => window.clearTimeout(t);
  }, [highlightOrderId, loading, rows.length]);

  const loadBills = async (requestIds: string[]) => {
    if (!requestIds.length) {
      setBillsByRequestId({});
      setEditedBillIds(new Set());
      setBillsLoaded(true);
      return;
    }
    // OTP-off: order_bills / order_items / bill_edit_audit direct reads are
    // RLS-blocked without an auth session — one RPC returns all three.
    const { data, error } = await supabase.rpc("get_my_order_bills", {
      p_user_phone: getUserPhone() ?? null,
      p_device_id: getDeviceId() ?? null,
      p_request_ids: requestIds,
    });
    // Keep the current map on transport errors, but ALWAYS replace it on a
    // successful (even empty) result — otherwise a just-voided bill stays
    // visible with an active Pay Now button until a full reload.
    if (error) {
      captureError(error, { scope: "myOrders.loadBills" });
      // Deduped by id so a failing 30s poll doesn't stack toasts.
      toast.error(s.myOrders_billsLoadError, { id: "myorders-bills-load-error" });
      setBillsLoaded(true);
      return;
    }

    type BillRpcRow = {
      id: string;
      request_id: string;
      total_amount: number;
      payment_mode: OrderBill["payment_mode"];
      payment_status: OrderBill["payment_status"];
      notes: string | null;
      items: OrderBill["items"];
      is_edited: boolean;
      created_at: string;
    };
    const bills = (data ?? []) as BillRpcRow[];

    const billMap: Record<string, OrderBill> = {};
    const edited = new Set<string>();
    const sortedBills = [...bills].sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const bill of sortedBills) {
      if (billMap[bill.request_id]) continue;
      billMap[bill.request_id] = {
        id: bill.id,
        total_amount: bill.total_amount,
        payment_mode: bill.payment_mode,
        payment_status: bill.payment_status,
        created_at: bill.created_at,
        notes: bill.notes,
        items: bill.items ?? [],
      };
      if (bill.is_edited) edited.add(bill.id);
    }
    setBillsByRequestId(billMap);
    setEditedBillIds(edited);
    setBillsLoaded(true);
  };

  const loadMyReviews = async () => {
    const userPhone = getUserPhone();
    const deviceId = getDeviceId();
    const { data, error } = await supabase
      .from("vendor_reviews")
      .select("id, request_id, rating, review_text, created_at, vendor_response, vendor_responded_at")
      .or(`user_phone.eq.${userPhone},device_id.eq.${deviceId}`);
    // Preserve the last-good map on error — wiping it would make already-rated
    // orders look unrated (Rate CTA reappears) on a transient failure.
    if (error) {
      captureError(error, { scope: "myOrders.loadMyReviews" });
      // Deduped by id so a failing 30s poll doesn't stack toasts.
      toast.error(s.myOrders_reviewsLoadError, { id: "myorders-reviews-load-error" });
      return;
    }
    const map: Record<
      string,
      {
        id: string;
        rating: number;
        review_text: string | null;
        created_at: string;
        vendor_response: string | null;
        vendor_responded_at: string | null;
      }
    > = {};
    for (const r of data ?? []) map[r.request_id] = r;
    setMyReviews(map);
  };

  const loadRecurring = async () => {
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    const { data, error } = await supabase.rpc("list_my_recurring_orders", {
      p_user_phone: userPhone ?? null,
      p_device_id: device_id ?? null,
    });
    if (error) {
      captureError(error, { scope: "myOrders.loadRecurring" });
      setRecurringOrders([]);
      return;
    }
    setRecurringOrders(
      ((data ?? []) as typeof recurringOrders).map((row) => ({
        id: row.id,
        vendor_id: row.vendor_id,
        shop_name: row.shop_name ?? null,
        category_label: row.category_label ?? null,
        service_mode: row.service_mode,
        interval_kind: row.interval_kind,
        interval_days: Number(row.interval_days) || 1,
        status: row.status,
        delivery_slot: row.delivery_slot ?? null,
        next_run_at: row.next_run_at,
      })),
    );
  };

  const setRecurringStatus = async (id: string, status: "paused" | "active" | "cancelled") => {
    if (recurringActionId) return;
    setRecurringActionId(id);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await supabase.rpc("customer_set_recurring_order_status", {
        p_recurring_order_id: id,
        p_status: status,
        p_user_phone: userPhone ?? null,
        p_device_id: device_id ?? null,
      });
      if (error) {
        toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
        return;
      }
      if (status === "cancelled") {
        toast.success(s.myOrders_recurringStopped);
      }
      await loadRecurring();
    } finally {
      setRecurringActionId(null);
    }
  };

  const loadMyKhata = async () => {
    const userPhone = getUserPhone();
    if (!userPhone) return;
    // OTP-off: khata_ledger direct read is RLS-blocked without an auth session.
    const { data, error } = await supabase.rpc("get_my_khata_ledger", {
      p_user_phone: userPhone,
    });
    if (error) {
      captureError(error, { scope: "myOrders.loadMyKhata" });
      // Deduped by id so a failing 30s poll doesn't stack toasts.
      toast.error(s.myOrders_khataLoadError, { id: "myorders-khata-load-error" });
      return;
    }

    const ledgerRows = filterKhataLedgerByOutstanding(
      ((data ?? []) as {
        vendor_id: string;
        total_outstanding: number;
        last_updated: string;
        shop_name: string | null;
      }[]).map((k) => ({
        vendor_id: k.vendor_id,
        shop_name: k.shop_name ?? "Unknown",
        total_outstanding: k.total_outstanding,
      })),
      false,
    );
    khataAllowAutoRatingRef.current = ledgerRows.length === 0;
    setMyKhata(ledgerRows);
  };

  const openKhataDetail = async (entry: {
    vendor_id: string;
    shop_name: string;
    total_outstanding: number;
  }) => {
    const userPhone = getUserPhone();
    if (!userPhone) return;
    khataDetailRetryRef.current = entry;
    setKhataDetail(entry);
    setKhataTxLoading(true);
    setKhataTxNetworkStatus(null);
    try {
      const { data, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            // OTP-off: khata_transactions direct read is RLS-blocked without a session.
            await supabase.rpc("get_my_khata_transactions", {
              p_user_phone: userPhone,
              p_vendor_id: entry.vendor_id,
            }),
          ),
        {
          onRetrying: () => setKhataTxNetworkStatus("retrying"),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      if (error) {
        toast.error(error.message);
        setKhataTransactions([]);
        return;
      }
      setKhataTransactions(currentCycleTransactions(data ?? []));
      setKhataTxNetworkStatus(null);
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        setKhataTxNetworkStatus("failed");
        setKhataTransactions([]);
      } else {
        throw err;
      }
    } finally {
      setKhataTxLoading(false);
    }
  };

  const closeKhataDetail = () => {
    setKhataDetail(null);
    setKhataTransactions([]);
    setKhataTxNetworkStatus(null);
    khataDetailRetryRef.current = null;
    khataAllowAutoRatingRef.current = true;
  };

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setBillsLoaded(false);
      setNetworkLoadStatus(null);
    }
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const [ordersResult, restrictionResult, blockResult] = await withNetworkRetry(async () => {
        const [ordersRes, restrictionRes, blockRes] = await Promise.all([
          supabase
            .rpc("get_my_orders", {
              p_user_phone: userPhone ?? null,
              p_device_id: device_id ?? null,
            })
            .retry(false),
          supabase
            .rpc("get_customer_payment_restriction_status", {
              p_user_phone: userPhone ?? null,
              p_device_id: device_id ?? null,
            })
            .retry(false),
          supabase
            .rpc("get_customer_payment_block_status", {
              p_user_phone: userPhone ?? null,
              p_device_id: device_id ?? null,
            })
            .retry(false),
        ]);
        throwOnSupabaseNetworkError(ordersRes);
        throwOnSupabaseNetworkError(restrictionRes);
        throwOnSupabaseNetworkError(blockRes);
        return [ordersRes, restrictionRes, blockRes] as const;
      }, {
        onRetrying: () => {
          if (!opts?.silent && mounted.current) setNetworkLoadStatus("retrying");
        },
        shouldRetry: () => getNavigatorOnline(),
      });
      if (!mounted.current) return;
      const { data, error } = ordersResult;
      const restrictionRow = restrictionResult.data?.[0] as { is_restricted?: boolean } | undefined;
      setPaymentSelfDeclareRestricted(Boolean(restrictionRow?.is_restricted));
      const blockRow = blockResult.data?.[0] as
        | { is_blocked?: boolean; request_id?: string | null }
        | undefined;
      setPaymentBlockRequestId(
        blockRow?.is_blocked && blockRow.request_id ? blockRow.request_id : null,
      );
      if (error) {
        captureError(error, { scope: "myOrders.load" });
        // Preserve the last-good list on any failed refresh (silent or not) —
        // a transient RPC failure must not look like "no orders".
        if (!opts?.silent) {
          setNetworkLoadStatus("failed");
          setLoading(false);
        }
        return;
      }
      type MyOrdersRpcRow = OrderRequestRow & {
        payment_status?: string | null;
        vendor_shop_name: string | null;
        vendor_service_mode: string | null;
        vendor_phone: string | null;
        vendor_latitude: number | null;
        vendor_longitude: number | null;
      };
      const list: RowWithShop[] = ((data ?? []) as MyOrdersRpcRow[]).map(
        ({ vendor_shop_name, vendor_service_mode, vendor_phone, vendor_latitude, vendor_longitude, ...r }) => ({
          ...(r as unknown as RowWithShop),
          vendors:
            vendor_shop_name !== null || vendor_phone !== null
              ? {
                  shop_name: vendor_shop_name ?? "",
                  service_mode: vendor_service_mode,
                  phone: vendor_phone,
                  latitude: vendor_latitude,
                  longitude: vendor_longitude,
                }
              : null,
        }),
      );
      setRows([...list]);
      setNetworkLoadStatus(null);
      void loadBills(list.map((r) => r.id));
      void loadMyReviews();
      void loadMyKhata();
      void loadRecurring();
      if (!opts?.silent) setLoading(false);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof NetworkExhaustedError) {
        if (!opts?.silent) {
          setNetworkLoadStatus("failed");
          setLoading(false);
        }
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const t = window.setInterval(() => void load({ silent: true }), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(t);
    };
  }, [load]);

  const overlayBlocksRef = useRef(false);

  const overlayBlocksAutoRating = useCallback((): boolean => {
    return isMyOrdersOverlayBlockingAutoRating({
      ratingSheetOpen,
      paymentSheetOpen: paymentSheetOrder !== null,
      paymentSheetLoading: paymentSheetLoadingId !== null,
      khataDetailOpen: khataDetail !== null,
      editOrderOpen: editOrder !== null,
      editingReviewOpen: editingReview !== null,
      aiSheetOpen,
      helpCallSheetOpen: helpCallVendor !== null,
      billHistoryOpen: historyBillId !== null,
    });
  }, [
    ratingSheetOpen,
    paymentSheetOrder,
    paymentSheetLoadingId,
    khataDetail,
    editOrder,
    editingReview,
    aiSheetOpen,
    helpCallVendor,
    historyBillId,
  ]);
  overlayBlocksRef.current = overlayBlocksAutoRating();

  const tryAutoTriggerRatingSheet = useCallback(
    (r: RowWithShop) => {
      const bill = billsByRequestIdRef.current[r.id];
      const action = resolveAutoRatingAction({
        alreadyShown: autoShownReviewsRef.current.has(r.id),
        alreadyReviewed: Boolean(myReviewsRef.current[r.id]),
        ratingSheetAlreadyOpenForOrder: ratingOpenForIdRef.current === r.id,
        overlayBlocking: overlayBlocksRef.current || !khataAllowAutoRatingRef.current,
        deferForUnpaidPayNow: shouldDeferAutoRatingForUnpaidPayNow({
          unpaidCashOrUpiBill: billBlocksDismiss(bill),
          customerOpenedPayment: openedPaymentOrderIdsRef.current.has(r.id),
        }),
      });
      if (action === "skip") {
        pendingAutoRatingRef.current = null;
        if (ratingOpenForIdRef.current === r.id) {
          consumeAutoRatingForOrder(r.id);
        }
        return;
      }
      if (action === "defer") {
        pendingAutoRatingRef.current = r;
        return;
      }

      pendingAutoRatingRef.current = null;
      setAutoShownReviews((prev) => new Set([...prev, r.id]));
      setRatingRequestId(r.id);
      setRatingVendor({
        vendorId: r.vendor_id,
        shopName: r.vendors?.shop_name ?? s.myOrders_shopFallback,
        serviceMode: r.vendors?.service_mode ?? "delivery",
        vendorPhone: r.vendors?.phone ?? null,
      });
      setRatingSheetOpen(true);
    },
    [consumeAutoRatingForOrder, s.myOrders_shopFallback],
  );

  const tryAutoTriggerRatingSheetRef = useRef(tryAutoTriggerRatingSheet);
  tryAutoTriggerRatingSheetRef.current = tryAutoTriggerRatingSheet;

  // Check for fulfilled orders that need auto-rating on mount/data refresh.
  // Wait for bills so unpaid Pay Now is visible before we decide to defer.
  useEffect(() => {
    if (loading || !billsLoaded || rows.length === 0) return;

    const eligibleOrders = rows.filter(
      (r) =>
        r.status === "fulfilled" &&
        !autoShownReviews.has(r.id) &&
        !myReviews[r.id],
    );

    if (eligibleOrders.length === 0) return;

    const mostRecentOrder = eligibleOrders.reduce((latest, current) =>
      new Date(current.created_at || 0) > new Date(latest.created_at || 0)
        ? current
        : latest,
    );

    const timer = window.setTimeout(() => {
      if (!mounted.current) return;
      tryAutoTriggerRatingSheetRef.current(mostRecentOrder);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [loading, billsLoaded, billsByRequestId, rows, myReviews, autoShownReviews, myKhata.length]);

  // Retry deferred auto-rating once overlays close, payment is opened, or the bill is paid.
  useEffect(() => {
    const pending = pendingAutoRatingRef.current;
    if (!pending || overlayBlocksAutoRating() || !khataAllowAutoRatingRef.current) return;
    const bill = billsByRequestId[pending.id];
    if (
      shouldDeferAutoRatingForUnpaidPayNow({
        unpaidCashOrUpiBill: billBlocksDismiss(bill),
        customerOpenedPayment: openedPaymentOrderIdsRef.current.has(pending.id),
      })
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!mounted.current) return;
      tryAutoTriggerRatingSheetRef.current(pending);
    }, 100);

    return () => window.clearTimeout(timer);
  }, [
    overlayBlocksAutoRating,
    ratingSheetOpen,
    paymentSheetOrder,
    paymentSheetLoadingId,
    khataDetail,
    editOrder,
    editingReview,
    aiSheetOpen,
    helpCallVendor,
    historyBillId,
    myKhata.length,
    billsByRequestId,
    billsLoaded,
  ]);

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mounted.current) return;
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        /* best-effort */
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, [acceptedHelpVendorIds]);

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;
    const stoppedRadiusM = config.vendorStoppedDistanceMeters;
    const stoppedMinutes = config.vendorStoppedMinutes;

    const onTick = () => {
      setLocationTick((n) => n + 1);
      setVendorStoppedByOrderId((prevStopped) => {
        const next = { ...prevStopped };
        for (const order of acceptedHelpOrders) {
          const history = vendorLocationHistoryRef.current.get(order.vendor_id) ?? [];
          next[order.id] = isVendorStoppedIncludingStale(
            history,
            stoppedRadiusM,
            stoppedMinutes,
          );
        }
        return next;
      });
    };

    const t = window.setInterval(onTick, 60_000);
    return () => window.clearInterval(t);
  }, [
    acceptedHelpVendorIds,
    acceptedHelpOrders,
    config.vendorStoppedDistanceMeters,
    config.vendorStoppedMinutes,
  ]);

  const applyVendorLocationUpdate = useCallback(
    (
      vendorId: string,
      latitude: number | null,
      longitude: number | null,
      lastUpdated: string | null,
    ) => {
      if (
        latitude == null ||
        longitude == null ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        return;
      }

      const timestamp = lastUpdated ? new Date(lastUpdated).getTime() : Date.now();
      const history = [...(vendorLocationHistoryRef.current.get(vendorId) ?? [])];
      const prev = history[history.length - 1];
      const live: VendorLiveLocation = {
        latitude,
        longitude,
        lastUpdated: lastUpdated ?? new Date().toISOString(),
      };

      if (
        prev &&
        prev.latitude === latitude &&
        prev.longitude === longitude &&
        Math.abs(prev.timestamp - timestamp) < 5000
      ) {
        setVendorLiveById((prevLive) => ({ ...prevLive, [vendorId]: live }));
        const stopped = computeVendorStopped(
          history,
          config.vendorStoppedDistanceMeters,
          config.vendorStoppedMinutes,
        );
        setVendorStoppedByOrderId((prevStopped) => {
          const next = { ...prevStopped };
          for (const order of acceptedHelpOrders) {
            if (order.vendor_id === vendorId) {
              next[order.id] = stopped;
            }
          }
          return next;
        });
        return;
      }

      history.push({ latitude, longitude, timestamp });
      vendorLocationHistoryRef.current.set(vendorId, history);
      setVendorLiveById((prevLive) => ({ ...prevLive, [vendorId]: live }));

      const stopped = computeVendorStopped(
        history,
        config.vendorStoppedDistanceMeters,
        config.vendorStoppedMinutes,
      );
      setVendorStoppedByOrderId((prevStopped) => {
        const next = { ...prevStopped };
        for (const order of acceptedHelpOrders) {
          if (order.vendor_id === vendorId) {
            next[order.id] = stopped;
          }
        }
        return next;
      });
    },
    [acceptedHelpOrders, config.vendorStoppedDistanceMeters, config.vendorStoppedMinutes],
  );

  useEffect(() => {
    if (acceptedHelpVendorIds.length === 0) return;

    let cancelled = false;
    const activeIds = new Set(acceptedHelpVendorIds);
    for (const key of vendorLocationHistoryRef.current.keys()) {
      if (!activeIds.has(key)) vendorLocationHistoryRef.current.delete(key);
    }

    void (async () => {
      const { data } = await fetchVendorsVisibleToCustomer(acceptedHelpVendorIds, {
        userPhone: getUserPhone(),
        deviceId: getDeviceId(),
      });
      if (cancelled || !data.length) return;
      for (const row of data) {
        applyVendorLocationUpdate(
          row.id,
          row.latitude,
          row.longitude,
          row.last_updated ?? null,
        );
      }
    })();

    const channel = supabase.channel("my-orders-vendor-locations");
    for (const vendorId of acceptedHelpVendorIds) {
      channel.on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "vendors",
          filter: `id=eq.${vendorId}`,
        },
        (payload) => {
          if (!mounted.current) return;
          const row = payload.new as {
            id: string;
            latitude: number | null;
            longitude: number | null;
            last_updated?: string | null;
          };
          applyVendorLocationUpdate(
            row.id,
            row.latitude,
            row.longitude,
            row.last_updated ?? null,
          );
        },
      );
    }
    channel.subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [acceptedHelpVendorIds, applyVendorLocationUpdate]);

  const closeAiSheet = useCallback((open: boolean) => {
    setAiSheetOpen(open);
    if (!open) {
      setHelpCallVendor(null);
    }
  }, []);

  const openHelpVendorCall = useCallback(
    async (order: RowWithShop) => {
      const phone = order.vendors?.phone?.trim();
      if (!phone) return;

      const live = vendorLiveById[order.vendor_id];
      const distM =
        live && userCoords
          ? distanceMeters(
              { lat: userCoords.lat, lng: userCoords.lng },
              { lat: live.latitude, lng: live.longitude },
            )
          : null;

      const { data: visibleVendors, error: vendorFetchError } =
        await fetchVendorsVisibleToCustomer([order.vendor_id], {
          userPhone: getUserPhone(),
          deviceId: getDeviceId(),
        });
      if (vendorFetchError) {
        captureError(vendorFetchError, {
          scope: "myOrders.openHelpVendorCall.fetchVendor",
          vendorId: order.vendor_id,
        });
      }
      const liveVendor = visibleVendors[0];

      setHelpCallVendor({
        vendor: {
          id: order.vendor_id,
          name: order.vendors?.shop_name ?? s.myOrders_shopFallback,
          shop_name: order.vendors?.shop_name ?? s.myOrders_shopFallback,
          category: "help",
          vendor_note: liveVendor?.vendor_note ?? null,
          phone,
          service_mode: (order.vendors?.service_mode ?? "help") as
            | "help"
            | "delivery"
            | "appointment"
            | "booking",
          verification_status: liveVendor?.verification_status ?? "unverified",
          is_manual_verified: liveVendor?.is_manual_verified === true,
          shop_photo_url: liveVendor?.shop_photo_url ?? null,
          upi_verified: liveVendor?.upi_verified === true,
          photo_selfie: liveVendor?.photo_selfie ?? null,
          latitude: liveVendor?.latitude ?? order.vendors?.latitude ?? null,
          total_helped: liveVendor?.total_helped ?? 0,
          on_time_rate: liveVendor?.on_time_rate ?? null,
        },
        userNeed: stripLocationTag(order.message),
        distanceKm: distM != null ? distM / 1000 : null,
        categoryId: order.category_id ?? null,
      });
      setAiSheetOpen(true);
    },
    [s.myOrders_shopFallback, userCoords, vendorLiveById],
  );

  useEffect(() => {
    const userPhone = getUserPhone();
    const device_id = getDeviceId();

    const channel = supabase
      .channel("my-orders-realtime")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "requests",
          filter: userPhone
            ? `user_phone=eq.${userPhone}`
            : `device_id=eq.${device_id}`,
        },
        (payload) => {
          if (!mounted.current) return;
          const updated = payload.new as { id: string; status?: string };
          if (updated.status === "done") {
            setRows((prev) => prev.filter((r) => r.id !== updated.id));
            setBillsByRequestId((prev) => {
              if (!(updated.id in prev)) return prev;
              const next = { ...prev };
              delete next[updated.id];
              return next;
            });
            return;
          }
          
          // Auto-trigger rating sheet when order becomes fulfilled
          if (updated.status === "fulfilled") {
            setRows((prev) => {
              const updatedRows = prev.map((r) =>
                r.id === updated.id ? { ...r, ...payload.new } : r,
              );
              // Find the newly fulfilled order and trigger rating
              const fulfilledOrder = updatedRows.find((r) => r.id === updated.id);
              if (fulfilledOrder) {
                window.setTimeout(() => {
                  if (!mounted.current) return;
                  tryAutoTriggerRatingSheetRef.current(fulfilledOrder);
                }, 100);
              }
              return updatedRows;
            });
          } else {
            setRows((prev) =>
              prev.map((r) =>
                r.id === updated.id ? { ...r, ...payload.new } : r,
              ),
            );
          }
          // Cancel voids unpaid bills server-side — drop the stale bill map
          // entry immediately so Pay Now cannot linger until the next poll.
          if (updated.status === "cancelled") {
            setBillsByRequestId((prev) => {
              if (!(updated.id in prev)) return prev;
              const next = { ...prev };
              delete next[updated.id];
              return next;
            });
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const markDone = async (target: RowWithShop | string) => {
    const id = typeof target === "string" ? target : target.id;
    const bill = billsByRequestId[id];
    if (billBlocksDismiss(bill)) {
      toast.error(s.myOrders_dismissBlockedUnpaid);
      return;
    }
    if (rowActionLockRef.current.has(id)) return;
    rowActionLockRef.current.add(id);
    setMarkingId(id);

    const row = typeof target === "string" ? null : target;
    const rowPhone = typeof target === "string" ? null : target.user_phone;
    const rowDevice = typeof target === "string" ? null : target.device_id;
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("dismiss_order", {
              p_request_id: id,
              p_device_id: rowDevice ?? device_id ?? null,
              p_user_phone: rowPhone ?? userPhone ?? null,
              p_appointment_status: null,
            }),
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
        toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
        return;
      }
      if (row && wasOrderEngaged(row)) {
        const vendorPhone = row.vendors?.phone?.trim();
        if (vendorPhone) {
          void invokeNotifyVendor({
            vendor_id: row.vendor_id,
            notification_title: s.myOrders_orderDismissedNotifyTitle,
            message: s.myOrders_orderDismissedNotifyBody,
            request_id: row.id,
            type: "order_update",
          });
        }
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void markDone(target), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      rowActionLockRef.current.delete(id);
      setMarkingId((current) => (current === id ? null : current));
    }
  };

  const handleRemoveOrder = async (r: RowWithShop) => {
    if (rowActionLockRef.current.has(r.id)) return;
    rowActionLockRef.current.add(r.id);
    setMarkingId(r.id);

    const vendorPhone = r.vendors?.phone?.trim();
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("cancel_customer_order", {
              p_request_id: r.id,
              p_device_id: r.device_id ?? device_id ?? null,
              p_user_phone: r.user_phone ?? userPhone ?? null,
            }),
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
        toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
        return;
      }
      if (vendorPhone && wasOrderEngaged(r)) {
        void invokeNotifyVendor({
          vendor_id: r.vendor_id,
          notification_title: s.myOrders_userCancelledNotifyTitle,
          message: s.myOrders_userCancelledNotifyBody,
          request_id: r.id,
          type: "order_update",
        });
      }
      setRows((prev) => prev.filter((row) => row.id !== r.id));
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleRemoveOrder(r), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      rowActionLockRef.current.delete(r.id);
      setMarkingId((current) => (current === r.id ? null : current));
    }
  };

  const cancelAppointment = async (r: RowWithShop) => {
    if (rowActionLockRef.current.has(r.id)) return;
    rowActionLockRef.current.add(r.id);
    setMarkingId(r.id);

    const vendorPhone = r.vendors?.phone?.trim();
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("dismiss_order", {
              p_request_id: r.id,
              p_device_id: r.device_id ?? device_id ?? null,
              p_user_phone: r.user_phone ?? userPhone ?? null,
              p_appointment_status: "cancelled",
            }),
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
        toast.error(s.myOrders_errCouldNotCancel, { description: error.message });
        return;
      }
      if (vendorPhone && wasOrderEngaged(r)) {
        void invokeNotifyVendor({
          vendor_id: r.vendor_id,
          notification_title: s.myOrders_userCancelledNotifyTitle,
          message: s.myOrders_userCancelledNotifyBody,
          request_id: r.id,
          type: "order_update",
        });
      }
      toast.success(s.myOrders_bookingCancelled);
      setRows((prev) => prev.filter((row) => row.id !== r.id));
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void cancelAppointment(r), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      rowActionLockRef.current.delete(r.id);
      setMarkingId((current) => (current === r.id ? null : current));
    }
  };

  const openEditSheet = (r: RowWithShop) => {
    setEditOrder(r);
    setEditMessage(stripLocationTag(r.message));
  };

  const closeEditSheet = () => {
    setEditOrder(null);
    setEditMessage("");
    setIsListeningEdit(false);
    setIsProcessingImageEdit(false);
  };

  const startVoiceEdit = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.home_voice_unavailable);
        return;
      }
      const micOk = await ensureVoiceMicrophone();
      if (!micOk) {
        toast.error(s.voice_permissionDenied);
        return;
      }
      setIsListeningEdit(true);
      const result = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      const text = result?.matches?.[0]?.trim();
      if (text) {
        setEditMessage((prev) => (prev ? `${prev} ${text}` : text));
      }
    } catch {
      // user cancelled or denied — silent
    } finally {
      setIsListeningEdit(false);
    }
  };

  const startImageEdit = async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setIsProcessingImageEdit(true);
        try {
          const base64 = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res((reader.result as string).split(",")[1]);
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
          const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-image-order`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ image_base64: base64, media_type: file.type }),
          });
          const data = await resp.json();
          if (data.success && data.text) {
            setEditMessage((prev) => (prev ? `${prev}\n${data.text}` : data.text));
            toast.success(s.image_parsed);
          } else {
            toast.error(s.image_failed);
          }
        } catch {
          toast.error(s.image_failed);
        } finally {
          setIsProcessingImageEdit(false);
        }
      };
      input.click();
    } catch {
      toast.error(s.image_failed);
      setIsProcessingImageEdit(false);
    }
  };

  const saveOrderEdit = async () => {
    if (!editOrder) return;
    const trimmed = editMessage.trim();
    if (!trimmed) return;
    const originalStripped = stripLocationTag(editOrder.message);
    if (trimmed === originalStripped) return;
    if (savingEditLockRef.current) return;

    savingEditLockRef.current = true;
    setSavingEdit(true);

    const releaseSavingEditLock = () => {
      savingEditLockRef.current = false;
      setSavingEdit(false);
    };

    const newMessage = buildMessageWithTags(trimmed, editOrder.message);
    const oldMessage = editOrder.message;

    const device_id = getDeviceId();
    const userPhone = getUserPhone();

    try {
      // No status pre-read: direct requests reads are RLS-blocked OTP-off, and
      // edit_customer_order already enforces status IN ('sent','seen') server-side.
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("edit_customer_order", {
              p_request_id: editOrder.id,
              p_message: newMessage,
              p_previous_message: oldMessage,
              p_device_id: editOrder.device_id ?? device_id ?? null,
              p_user_phone: editOrder.user_phone ?? userPhone ?? null,
            }),
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
        if (error.message.includes("not_editable_or_unauthorized")) {
          toast.error(s.order_no_longer_editable);
          closeEditSheet();
        } else {
          toast.error(s.myOrders_errCouldNotUpdate, { description: error.message });
        }
        return;
      }

      setRows((prev) =>
        prev.map((r) =>
          r.id === editOrder.id
            ? {
                ...r,
                message: newMessage,
                previous_message: oldMessage,
                is_edited: true,
              }
            : r,
        ),
      );

      const hasAppointment =
        editOrder.appointment_time != null && String(editOrder.appointment_time).trim() !== "";
      const today = new Date().toDateString();
      const referenceDate = hasAppointment
        ? new Date(editOrder.appointment_time!).toDateString()
        : new Date(editOrder.created_at).toDateString();
      const isSameDay = referenceDate === today;
      const customerName = userPhone ?? "Customer";

      const notificationTitle = hasAppointment
        ? isSameDay
          ? "⚠️ Customer edited today's booking!"
          : "✏️ Booking edited"
        : isSameDay
          ? "⚠️ Customer edited today's order!"
          : "✏️ Order edited";
      const notificationBody = hasAppointment
        ? isSameDay
          ? `${customerName} changed their order — check details now`
          : `${customerName} updated their booking details`
        : isSameDay
          ? `${customerName} changed their order — check details now`
          : `${customerName} updated their order details`;

      // Push dedup: the old direct user_notifications read queried the VENDOR's
      // rows from the customer's client — wrong owner, always blocked by RLS, so
      // dedup never fired. The RPC verifies the caller owns this request and
      // checks the vendor's recent order_update notifications server-side.
      let skipPush = false;
      const { data: shouldNotify, error: dedupError } = await supabase.rpc(
        "should_notify_vendor_order_edit",
        {
          p_request_id: editOrder.id,
          p_user_phone: getUserPhone(),
          p_device_id: getDeviceId(),
        },
      );
      if (!dedupError && shouldNotify === false) {
        skipPush = true;
      }

      if (!skipPush) {
        void invokeNotifyVendor({
          vendor_id: editOrder.vendor_id,
          notification_title: notificationTitle,
          message: notificationBody,
          request_id: editOrder.id,
          type: "order_update",
        });
      }

      toast.success(s.orderUpdated);
      closeEditSheet();
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveOrderEdit(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      releaseSavingEditLock();
    }
  };

  const handleFulfilledDismiss = (r: RowWithShop) => {
    consumeAutoRatingForOrder(r.id);
    setPendingDismissId(r.id);
    setRatingRequestId(r.id);
    setRatingVendor({
      vendorId: r.vendor_id,
      shopName: r.vendors?.shop_name ?? s.myOrders_shopFallback,
      serviceMode: r.vendors?.service_mode ?? "delivery",
      vendorPhone: r.vendors?.phone ?? null,
    });
    setRatingSheetOpen(true);
  };

  const openPaymentSheet = async (r: RowWithShop, bill: OrderBill) => {
    setPaymentSheetLoadingId(r.id);
    const { data: vendorData, error } = r.category_id
      ? await supabase
          .from("vendor_categories")
          .select("upi_id, upi_qr_url, upi_qr_payee_id")
          .eq("vendor_id", r.vendor_id)
          .eq("category_id", r.category_id)
          .maybeSingle()
      : { data: null, error: null };
    setPaymentSheetLoadingId(null);
    if (error || !r.category_id || !vendorData) {
      toast.error(s.payment_confirm_error);
      return;
    }
    openedPaymentOrderIdsRef.current.add(r.id);
    setPaymentSheetOrder({
      id: r.id,
      status: r.status,
      payment_status: r.payment_status ?? "unpaid",
      amountRupees: bill.total_amount,
    });
    setPaymentSheetVendor({
      vendor_id: r.vendor_id,
      shop_name: r.vendors?.shop_name ?? "",
      upi_id: vendorData.upi_id ?? "",
      phone: r.vendors?.phone ?? "",
      upi_qr_url: vendorData.upi_qr_url ?? null,
      upi_qr_payee_id: vendorData.upi_qr_payee_id ?? null,
    });
  };

  const orderStatusPillClass = (r: RowWithShop) => {
    if (r.status === "cancelled") return "bg-red-500/20 text-red-400 border-red-500/30";
    if (r.status === "expired") return "bg-amber-500/20 text-amber-500 border-amber-500/30";
    if (r.status === "fulfilled" || r.status === "done") return "bg-green-500/20 text-green-400 border-green-500/30";
    return "bg-brand/20 text-brand border-brand/30";
  };

  return (
    <AppShell theme="dark">
      <div className="space-y-3 pb-24" data-testid="my-orders-screen">
      <div className="flex items-start gap-3 pr-4">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="h-10 w-10 shrink-0 grid place-items-center rounded-xl border border-surface-border bg-surface ml-4"
          aria-label={s.myOrders_backToHome}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <SettingsPageHeader title={s.myOrders_heading} subtitle={s.myOrders_appName} />
        </div>
        <NotificationBell className="mt-6 shrink-0" />
      </div>

      <div className="relative mx-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={s.search_ordersPlaceholder}
          className="w-full bg-surface border border-surface-border rounded-2xl pl-9 pr-10 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {recurringOrders.length > 0 && (
        <>
          <SettingsSectionLabel>{s.myOrders_recurringHeading}</SettingsSectionLabel>
          <SettingsCard>
            {recurringOrders.map((ro, idx) => {
              const intervalLabel =
                ro.interval_kind === "daily"
                  ? s.myOrders_recurringDaily
                  : ro.interval_kind === "weekly"
                    ? s.myOrders_recurringWeekly
                    : s.myOrders_recurringCustom.replace("{days}", String(ro.interval_days));
              return (
                <div
                  key={ro.id}
                  data-testid={`recurring-order-card-${ro.id}`}
                  className={cn(
                    "px-4 py-3.5 space-y-2",
                    idx < recurringOrders.length - 1 && "border-b border-surface-border",
                  )}
                >
                  <div className="flex justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-foreground truncate">
                        {ro.shop_name ?? s.myOrders_shopFallback}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {intervalLabel}
                        {ro.category_label ? ` · ${ro.category_label}` : ""}
                        {ro.status === "paused" ? ` · ${s.myOrders_recurringPaused}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {ro.status === "active" ? (
                      <button
                        type="button"
                        data-testid={`recurring-order-pause-${ro.id}`}
                        disabled={recurringActionId === ro.id}
                        onClick={() => void setRecurringStatus(ro.id, "paused")}
                        className="flex-1 rounded-xl border border-surface-border py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        {s.myOrders_recurringPause}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`recurring-order-resume-${ro.id}`}
                        disabled={recurringActionId === ro.id}
                        onClick={() => void setRecurringStatus(ro.id, "active")}
                        className="flex-1 rounded-xl border border-surface-border py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        {s.myOrders_recurringResume}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid={`recurring-order-stop-${ro.id}`}
                      disabled={recurringActionId === ro.id}
                      onClick={() => void setRecurringStatus(ro.id, "cancelled")}
                      className="flex-1 rounded-xl border border-destructive/40 text-destructive py-2 text-xs font-semibold disabled:opacity-50"
                    >
                      {s.myOrders_recurringStop}
                    </button>
                  </div>
                </div>
              );
            })}
          </SettingsCard>
        </>
      )}

      {myKhata.length > 0 && (
        <>
          <SettingsSectionLabel>📒 {s.khata_myTabs}</SettingsSectionLabel>
          <SettingsCard className="border-amber-500/30 bg-amber-500/5">
            {myKhata.map((k, idx) => (
              <button
                key={k.vendor_id}
                type="button"
                onClick={() => void openKhataDetail(k)}
                className={cn(
                  "w-full flex justify-between gap-3 px-4 py-3.5 text-left active:opacity-80",
                  idx < myKhata.length - 1 && "border-b border-surface-border",
                )}
              >
                <span className="text-sm font-bold text-foreground">{k.shop_name}</span>
                {(() => {
                  const balance = formatKhataBalanceDisplay(k.total_outstanding, s);
                  return (
                    <span className={cn("text-sm font-bold tabular-nums shrink-0", balance.colorClass)}>
                      {balance.text}
                    </span>
                  );
                })()}
              </button>
            ))}
          </SettingsCard>
        </>
      )}

      {networkLoadStatus && (
        <NetworkErrorBanner
          status={networkLoadStatus}
          onRetry={networkLoadStatus === "failed" ? () => void load() : undefined}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : networkLoadStatus === "failed" ? null : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {s.myOrders_noOrders}
            <br />
            {s.myOrders_noOrdersHint}
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
          >
            {s.myOrders_findVendors}
          </button>
        </div>
      ) : searchQuery.trim() && filteredRows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {s.search_noResults}
        </div>
      ) : (
        <>
        <SettingsSectionLabel>{s.myOrders_heading}</SettingsSectionLabel>
        <ul className="space-y-3 pb-4">
          {filteredRows.map((r) => (
            <li
              key={r.id}
              id={`order-card-${r.id}`}
              data-testid="order-card"
              className={cn(
                "mx-4 rounded-2xl border border-surface-border bg-surface p-4 space-y-2 mb-3",
                r.status === "cancelled" && "border-red-500/30 bg-red-500/5",
                r.status === "expired" && "border-amber-500/30 bg-amber-500/5",
                flashOrderId === r.id &&
                  "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-foreground truncate min-w-0">
                  {r.vendors?.shop_name ?? s.myOrders_shopFallback}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  {(r.status === "sent" || r.status === "seen") &&
                    r.appointment_status !== "declined" && (
                    <button
                      type="button"
                      onClick={() => openEditSheet(r)}
                      className="h-8 w-8 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
                      aria-label={s.editOrder}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatTimeAgo(r.created_at)}
                  </span>
                </div>
              </div>
              <span
                data-testid="order-status-badge"
                className={cn(
                  "inline-flex rounded-full text-[11px] font-semibold px-2.5 py-1 border",
                  orderStatusPillClass(r),
                )}
              >
                {userStatusLabel(r, s)}
              </span>
              {isDeliveryAcceptedOverdue(r) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                  <p className="text-[11px] text-amber-400 text-center leading-snug font-semibold">
                    {s.delivery_accepted_overdue_title}
                  </p>
                  <p className="text-[11px] text-amber-400 text-center leading-snug">
                    {s.delivery_accepted_overdue_body}
                  </p>
                  {canShowCustomerCancelOrder(r) ? (
                    <button
                      type="button"
                      data-testid="order-cancel-btn"
                      disabled={markingId === r.id}
                      onClick={() => void handleRemoveOrder(r)}
                      className="w-full rounded-xl border border-destructive/40 text-destructive text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.myOrders_saving : s.myOrders_cancelOrder}
                    </button>
                  ) : billBlocksDismiss(billsByRequestId[r.id]) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-[10px] text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={markingId === r.id}
                      onClick={() => void markDone(r)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )}
                </div>
              )}
              {isBookingConfirmedOverdue(r) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                  <p className="text-[11px] text-amber-400 text-center leading-snug font-semibold">
                    {s.booking_confirmed_overdue_title}
                  </p>
                  <p className="text-[11px] text-amber-400 text-center leading-snug">
                    {s.booking_confirmed_overdue_body}
                  </p>
                  {billBlocksDismiss(billsByRequestId[r.id]) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-[10px] text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={markingId === r.id}
                      onClick={() => void markDone(r)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )}
                </div>
              )}
              <p className="text-sm text-foreground/90 leading-snug whitespace-pre-wrap break-words">
                {stripLocationTag(r.message)}
              </p>
              {billsByRequestId[r.id] &&
                (() => {
                  const bill = billsByRequestId[r.id];
                  return (
                    <div className="rounded-xl border border-brand-border bg-brand/5 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-brand">{s.bill_title}</p>
                        {editedBillIds.has(bill.id) && (
                          <button
                            type="button"
                            data-testid="my-orders-bill-edited-badge"
                            onClick={() => setHistoryBillId(bill.id)}
                            className="text-[10px] font-semibold text-brand underline shrink-0"
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
                            <p className="text-[11px] text-amber-400 text-center leading-snug">
                              {s.payment_hygiene_unpaid_warning}
                            </p>
                          </div>
                        )}
                      {r.payment_status === "claimed" && (
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />
                          {s.payment_claimed}
                        </div>
                      )}
                      {r.payment_status === "confirmed" && (
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
                          {s.payment_confirmed}
                        </div>
                      )}
                      {r.payment_status === "disputed" && (
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
                          {r.vendors?.phone?.trim() && (
                            <button
                              type="button"
                              onClick={() => void openHelpVendorCall(r)}
                              className="text-xs text-brand font-semibold border border-brand/40 rounded-lg px-3 py-1"
                            >
                              {s.ai_bridge_call_now}
                            </button>
                          )}
                          {canCustomerSelfDeclarePayment(r, bill, paymentSelfDeclareRestricted) ? (
                            <button
                              type="button"
                              data-testid="my-orders-pay-now-btn"
                              disabled={paymentSheetLoadingId === r.id}
                              className="text-xs text-amber-500 font-semibold border border-amber-500/50 rounded-lg px-3 py-1 disabled:opacity-50 inline-flex items-center gap-1.5"
                              onClick={() => void openPaymentSheet(r, bill)}
                            >
                              {paymentSheetLoadingId === r.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              {s.payment_pay_now}
                            </button>
                          ) : isCustomerSelfDeclarePaymentEligible(r, bill) &&
                            paymentSelfDeclareRestricted ? (
                            r.id === paymentBlockRequestId ? (
                              <span
                                data-testid="my-orders-payment-restricted-blocking-bill"
                                className="text-xs text-amber-700 dark:text-amber-400 max-w-[14rem] text-right leading-snug"
                              >
                                {s.payment_restricted_blocking_bill_resolve(
                                  r.vendors?.shop_name?.trim() || s.myOrders_shopFallback,
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
              {(r.status === "fulfilled" || r.status === "done") &&
                myReviews[r.id] &&
                (() => {
                  const review = myReviews[r.id];
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
                              setEditingReview({
                                id: review.id,
                                vendorId: r.vendor_id,
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
                          <p className="text-[10px] text-brand font-semibold">{s.review_vendorSays}</p>
                          <p className="text-xs text-foreground">{review.vendor_response}</p>
                          {review.vendor_responded_at && (
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {formatTimeAgo(review.vendor_responded_at)}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              {customerOrderShowsLiveLocation({
                id: r.id,
                status: r.status,
                created_at: r.created_at,
                delivery_slot: r.delivery_slot,
                appointment_time: r.appointment_time,
                appointment_status: r.appointment_status,
                service_mode: r.service_mode ?? r.vendors?.service_mode,
              }) &&
                (() => {
                  const live = vendorLiveById[r.vendor_id];
                  const distM =
                    live && userCoords
                      ? distanceMeters(
                          { lat: userCoords.lat, lng: userCoords.lng },
                          { lat: live.latitude, lng: live.longitude },
                        )
                      : null;
                  void locationTick;
                  const isHelpOrder =
                    String(r.service_mode ?? r.vendors?.service_mode ?? "")
                      .trim()
                      .toLowerCase() === "help";
                  return (
                    <>
                      {live && distM != null && (
                        <p className="text-[11px] text-brand">
                          📍 Vendor is {formatVendorDistance(distM)} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {!live && (
                        <p className="text-[11px] text-muted-foreground">📍 {s.vendor_distance}</p>
                      )}
                      {live && distM == null && (
                        <p className="text-[11px] text-brand">
                          📍 {s.vendor_distance} · {s.vendor_last_updated}{" "}
                          {formatTimeAgo(live.lastUpdated)}
                        </p>
                      )}
                      {vendorStoppedByOrderId[r.id] && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                          <p className="text-[11px] text-amber-400 text-center leading-snug">
                            {s.vendor_stopped_warning}
                          </p>
                          {r.vendors?.phone && (
                            <button
                              type="button"
                              onClick={() => void openHelpVendorCall(r)}
                              className="w-full rounded-lg border border-brand/40 text-brand text-xs font-semibold py-2"
                            >
                              {s.radar_connect_ai}
                            </button>
                          )}
                        </div>
                      )}
                      {isHelpOrder &&
                        isHelpAcceptDelayedRow(r, config.helpAcceptTimeoutHours) && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                          <p className="text-[11px] text-amber-400 text-center leading-snug">
                            {formatHelpDelayedWarning(
                              s.order_help_delayed_warning,
                              config.helpAcceptTimeoutHours,
                            )}
                          </p>
                        </div>
                      )}
                    </>
                  );
                })()}
              {r.status === "cancelled" && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {/* cancel_reason is only recorded by vendor_cancel_order;
                        customer cancels (cancel_customer_order) never set it —
                        same origin discriminator as the status pill above. */}
                    {r.cancel_reason?.trim() || s.myOrders_youCancelledDefault}
                  </p>
                </div>
              )}
              {r.status === "expired" && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {s.myOrders_expiredBanner}
                  </p>
                </div>
              )}
              {(() => {
                const slot = deliverySlotLabel(r.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="mt-1 rounded-lg border border-brand-border bg-brand/5 px-3 py-2 text-[11px]">
                    {s.myOrders_deliverySlotPrefix}<span className="text-green-700 dark:text-brand font-semibold">{slot}</span>
                  </div>
                );
              })()}
              {r.appointment_time &&
                (() => {
                  const msg = r.message ?? "";
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
                    <div className={`mt-2 rounded-lg border px-3 py-2 text-[11px] space-y-0.5 ${borderColor}`}>
                      <div className={`font-semibold ${labelColor}`}>{locationLabel}</div>
                      <div>
                        {s.myOrders_apptAround}
                        <span className={`font-semibold ${timeColor}`}>
                          {new Date(r.appointment_time).toLocaleString("en-IN", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {r.appointment_status === "confirmed" &&
                            r.status !== "cancelled" &&
                            r.status !== "fulfilled" &&
                            r.status !== "done" &&
                            s.myOrders_apptConfirmed}
                          {r.appointment_status === "declined" && s.myOrders_apptDeclined}
                          {r.appointment_status === "cancelled" && s.myOrders_apptCancelled}
                          {r.appointment_status === "pending" && s.myOrders_apptAwaiting}
                        </span>
                      </div>
                    </div>
                  );
                })()}

              {(() => {
                const mapsUrl = resolveCustomerNavigateToVendorUrl(r);
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

              {r.appointment_time &&
                r.status !== "fulfilled" &&
                r.status !== "done" &&
                r.status !== "cancelled" &&
                (() => {
                  if (
                    r.appointment_status === "declined" ||
                    r.appointment_status === "cancelled"
                  ) {
                    return (
                      <button
                        type="button"
                        onClick={() => void cancelAppointment(r)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_dismiss}
                      </button>
                    );
                  }

                  const appointmentDate = new Date(r.appointment_time);
                  const today = new Date();
                  const isSameDay = appointmentDate.toDateString() === today.toDateString();
                  const isPast = appointmentDate < today;

                  if (isPast) return null;

                  if (!isSameDay) {
                    return (
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        onClick={() => setShowCancelConfirm((p) => ({ ...p, [r.id]: true }))}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    );
                  }

                  if (!calledVendor[r.id]) {
                    return (
                      <div className="space-y-2">
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400 text-center">
                          {s.myOrders_sameDayWarning}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void openHelpVendorCall(r);
                            setTimeout(() => setCalledVendor((p) => ({ ...p, [r.id]: true })), 3000);
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
                      <p className="text-[11px] text-gray-400 text-center">
                        {s.myOrders_callDone}
                      </p>
                      {/* One-tap cancel after the call, without an extra confirmation
                          dialog, is a deliberate product decision — the call itself is
                          the confirmation step. Do not add friction here. */}
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        onClick={() => void cancelAppointment(r)}
                        className="w-full rounded-lg border border-destructive/40 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                      >
                        {s.myOrders_cancelBooking}
                      </button>
                    </div>
                  );
                })()}

              {showCancelConfirm[r.id] && r.status !== "cancelled" && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-xs text-destructive font-semibold text-center">
                    {s.myOrders_confirmCancelQ}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void cancelAppointment(r)}
                      className="rounded-lg bg-destructive text-white text-xs font-semibold py-2"
                    >
                      {s.myOrders_yesCancel}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                      className="rounded-lg border border-border text-xs font-semibold py-2"
                    >
                      {s.myOrders_keepIt}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {r.status === "cancelled" || r.status === "expired" ? (
                  billBlocksDismiss(billsByRequestId[r.id]) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-[10px] text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={markingId === r.id}
                      onClick={() => void markDone(r)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  )
                ) : null}
                {r.status === "fulfilled" ? (
                  billBlocksDismiss(billsByRequestId[r.id]) ? (
                    <div className="space-y-1">
                      <button
                        type="button"
                        data-testid="order-dismiss-btn"
                        disabled
                        className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 opacity-50 cursor-not-allowed"
                      >
                        {s.myOrders_dismiss}
                      </button>
                      <p
                        data-testid="order-dismiss-blocked-unpaid"
                        className="text-[10px] text-muted-foreground text-center leading-snug"
                      >
                        {s.myOrders_dismissBlockedUnpaid}
                      </p>
                    </div>
                  ) : myReviews[r.id] ? (
                    <button
                      type="button"
                      data-testid="order-dismiss-btn"
                      disabled={markingId === r.id}
                      onClick={() => void markDone(r)}
                      className="w-full rounded-xl border border-border bg-card text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.myOrders_saving : s.myOrders_dismiss}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="order-rate-btn"
                      disabled={markingId === r.id}
                      onClick={() => handleFulfilledDismiss(r)}
                      className="w-full rounded-2xl bg-brand text-page-bg text-sm font-semibold py-3 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id
                        ? s.myOrders_saving
                        : fulfilledOrderCtaLabel(r.vendors?.service_mode, s)}
                    </button>
                  )
                ) : null}
                {r.status !== "cancelled" &&
                  !r.appointment_time &&
                  (canShowRemoveOrder(r) ? (
                    !showOrderCancelConfirm[r.id] ? (
                      <button
                        type="button"
                        data-testid="order-cancel-btn"
                        disabled={markingId === r.id}
                        onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: true }))}
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
                            disabled={markingId === r.id}
                            onClick={() => void handleRemoveOrder(r)}
                            className="rounded-lg bg-destructive text-white text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {s.myOrders_yesCancel}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowOrderCancelConfirm((p) => ({ ...p, [r.id]: false }))}
                            className="rounded-lg border border-border text-xs font-semibold py-2"
                          >
                            {s.myOrders_keepIt}
                          </button>
                        </div>
                      </div>
                    )
                  ) : r.status === "seen" &&
                    !canShowPreAcceptCancel(r) &&
                    orderCreatedWithinLast24h(r.created_at) ? (
                    <p className="text-[11px] text-muted-foreground text-center px-1">
                      {s.myOrders_cannotCancel}
                    </p>
                  ) : null)}
              </div>
            </li>
          ))}
        </ul>
        </>
      )}

      <Sheet open={editOrder != null} onOpenChange={(open) => !open && closeEditSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>{s.editOrder}</SheetTitle>
          </SheetHeader>
          {editOrder?.status === "seen" && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
              {s.vendorSeenWarning}
            </p>
          )}
          <div className="relative mt-3">
            <textarea
              value={editMessage}
              onChange={(e) => setEditMessage(e.target.value.slice(0, MAX_LEN))}
              rows={4}
              className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary pr-20"
              placeholder={s.editOrder_messagePlaceholder}
            />
            <button
              type="button"
              onClick={() => void startImageEdit()}
              disabled={isProcessingImageEdit}
              className="absolute bottom-3 right-10 p-1.5 rounded-full bg-surface-raised text-gray-400 hover:text-brand transition-colors disabled:opacity-50"
            >
              {isProcessingImageEdit ? (
                <Loader2Icon className="h-4 w-4 animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
            </button>
            {Capacitor.isNativePlatform() && (
              <button
                type="button"
                onClick={() => void startVoiceEdit()}
                className={`absolute bottom-3 right-3 p-1.5 rounded-full transition-colors ${
                  isListeningEdit
                    ? "bg-danger text-white animate-pulse"
                    : "bg-surface-raised text-gray-400 hover:text-brand"
                }`}
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground text-right mt-1">
            {editMessage.length}/{MAX_LEN}
          </p>
          {editOrder?.delivery_address?.trim() && (
            <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {editOrder.delivery_address.trim()}
            </p>
          )}
          {editOrder &&
            (() => {
              const slot = deliverySlotLabel(editOrder.delivery_slot, slotLabels);
              if (!slot) return null;
              return (
                <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  {slot}
                </p>
              );
            })()}
          {editOrder?.appointment_time &&
            String(editOrder.appointment_time).trim() !== "" && (
              <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {new Date(editOrder.appointment_time).toLocaleString("en-IN", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
          {(editOrder?.delivery_address?.trim() ||
            deliverySlotLabel(editOrder?.delivery_slot, slotLabels) ||
            (editOrder?.appointment_time &&
              String(editOrder.appointment_time).trim() !== "")) && (
            <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
              {s.edit_address_hint}
            </p>
          )}
          <button
            type="button"
            disabled={
              savingEdit ||
              !editMessage.trim() ||
              !editOrder ||
              editMessage.trim() === stripLocationTag(editOrder.message)
            }
            onClick={() => void saveOrderEdit()}
            className={cn(
              "mt-4 w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold disabled:opacity-50",
            )}
          >
            {savingEdit ? s.myOrders_saving : s.saveChanges}
          </button>
        </SheetContent>
      </Sheet>

      <Sheet open={editingReview !== null} onOpenChange={(open) => !open && setEditingReview(null)}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{s.review_editTitle}</SheetTitle>
          </SheetHeader>
          {editingReview && (
            <div className="mt-4 space-y-3">
              <div className="flex gap-2 justify-center">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() =>
                      setEditingReview((p) => (p ? { ...p, rating: n } : null))
                    }
                    className={`text-2xl transition-transform ${
                      n <= editingReview.rating ? "opacity-100" : "opacity-30"
                    }`}
                  >
                    ⭐
                  </button>
                ))}
              </div>
              <textarea
                value={editingReview.text}
                onChange={(e) =>
                  setEditingReview((p) =>
                    p ? { ...p, text: e.target.value.slice(0, 200) } : null,
                  )
                }
                rows={2}
                placeholder={s.review_placeholder}
                className="w-full bg-surface border border-surface-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand resize-none"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!editingReview) return;
                  try {
                    const { error } = await supabase.rpc("update_vendor_review", {
                      p_review_id: editingReview.id,
                      p_user_phone: getUserPhone(),
                      p_rating: editingReview.rating,
                      p_review_text: editingReview.text.trim() || null,
                    });
                    if (error) {
                      toast.error(s.rating_errCouldNotSave);
                      return;
                    }
                    await syncVendorRatingFromReviews(editingReview.vendorId);
                    toast.success(s.review_updated);
                    setEditingReview(null);
                    void loadMyReviews();
                  } catch {
                    toast.error(s.rating_errCouldNotSave);
                  }
                }}
                className="w-full rounded-xl bg-brand text-page-bg py-3 font-semibold"
              >
                {s.review_saveEdit}
              </button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <RatingSheet
        isOpen={ratingSheetOpen}
        shopName={ratingVendor?.shopName ?? ""}
        serviceMode={ratingVendor?.serviceMode ?? "delivery"}
        vendorId={ratingVendor?.vendorId ?? ""}
        vendorPhone={ratingVendor?.vendorPhone}
        requestId={ratingRequestId ?? ""}
        onDismiss={async () => {
          if (ratingRequestId) consumeAutoRatingForOrder(ratingRequestId);
          setRatingSheetOpen(false);
          const dismissId = pendingDismissId;
          const row = dismissId ? rows.find((r) => r.id === dismissId) : undefined;
          const bill = dismissId ? billsByRequestId[dismissId] : undefined;
          if (dismissId && billBlocksDismiss(bill)) {
            toast.error(s.myOrders_dismissBlockedUnpaid);
          } else if (dismissId) {
            await markDone(row ?? dismissId);
          }
          setPendingDismissId(null);
          setRatingRequestId(null);
          setRatingVendor(null);

          // Refresh reviews to capture any newly submitted rating
          void loadMyReviews();
        }}
      />

      {paymentSheetOrder && paymentSheetVendor && (
        <PaymentSheet
          open={paymentSheetOrder !== null}
          onClose={() => {
            setPaymentSheetOrder(null);
            setPaymentSheetVendor(null);
          }}
          order={paymentSheetOrder}
          vendor={paymentSheetVendor}
        />
      )}

      <Sheet open={khataDetail != null} onOpenChange={(open) => !open && closeKhataDetail()}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[85vh] flex flex-col">
          <SheetHeader className="text-left shrink-0">
            <SheetTitle>{khataDetail?.shop_name ?? ""}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex flex-col min-h-0 flex-1 overflow-hidden">
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
              {khataTxNetworkStatus && (
                <NetworkErrorBanner
                  status={khataTxNetworkStatus}
                  className="mb-0"
                  onRetry={
                    khataTxNetworkStatus === "failed" && khataDetailRetryRef.current
                      ? () => void openKhataDetail(khataDetailRetryRef.current!)
                      : undefined
                  }
                />
              )}
              {khataTxLoading && !khataTxNetworkStatus ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : khataTxNetworkStatus === "failed" ? null : khataTransactions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No transactions</p>
              ) : (
                <ul className="space-y-2">
                  {khataTransactions.map((tx) => (
                    <li
                      key={tx.id}
                      className="rounded-xl border border-surface-border bg-surface/50 px-3 py-2.5 space-y-1"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          {formatKhataDate(tx.created_at)}
                        </p>
                        <p className="text-sm font-bold text-foreground tabular-nums">
                          ₹{Number(tx.amount).toFixed(2)}
                        </p>
                      </div>
                      <p
                        className={cn(
                          "text-sm leading-snug whitespace-pre-wrap break-words",
                          tx.note?.trim()
                            ? "text-foreground font-medium"
                            : "text-muted-foreground italic",
                        )}
                      >
                        {tx.note?.trim() || "No description"}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <KhataTxSourceChip tx={tx} />
                        <Badge variant="outline" className="text-[10px] font-semibold">
                          {khataPaymentModeLabel(tx.payment_mode, s)}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {khataDetail && (() => {
              const balance = formatKhataBalanceDisplay(khataDetail.total_outstanding, s);
              return (
                <div className="border-t border-surface-border pt-4 mt-4 shrink-0 flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {khataDetail.total_outstanding < 0 ? s.khata_refundDue : "Total outstanding"}
                  </span>
                  <span className={cn("text-lg font-bold tabular-nums", balance.colorClass)}>
                    {khataDetail.total_outstanding < 0
                      ? `₹${Math.abs(khataDetail.total_outstanding).toFixed(2)}`
                      : `₹${khataDetail.total_outstanding.toFixed(2)}`}
                  </span>
                </div>
              );
            })()}
          </div>
        </SheetContent>
      </Sheet>

      <BillEditHistorySheet
        billId={historyBillId}
        isOpen={historyBillId !== null}
        onClose={() => setHistoryBillId(null)}
      />

      {helpCallVendor && (
        <AiBridgeSheet
          open={aiSheetOpen}
          onClose={() => closeAiSheet(false)}
          vendor={helpCallVendor.vendor}
          callerPhone={getUserPhone() ?? ""}
          userNeed={helpCallVendor.userNeed}
          categoryId={helpCallVendor.categoryId}
          distanceKm={helpCallVendor.distanceKm}
        />
      )}
      </div>
    </AppShell>
  );
};

export default MyOrders;
