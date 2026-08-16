import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase, invokecalculateTrustScore, invokeNotifyUser, useCategoryLabel } from "@/lib/supabase";
import { formatTimeAgo, type OrderRequestRow } from "@/lib/orders";
import { Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { openGoogleMaps, resolveVendorNavigateToCustomerUrl } from "@/lib/mapsDeepLink";
import { BillSheet } from "@/components/BillSheet";
import { BillEditSheet } from "@/components/BillEditSheet";
import { BillEditHistorySheet } from "@/components/BillEditHistorySheet";
import { fetchEditedBillIds, type VendorEditBillResult } from "@/lib/billEdit";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { getUserPhone } from "@/lib/userIdentity";
import { addBreadcrumb, captureError } from "@/lib/sentry";
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  resolveCancelReasonsForCategory,
  resolveCategoryBrandName,
} from "@/lib/categoryScopedVendor";
import {
  isKhataRedLimitExceededError,
  messageForKhataChargeError,
} from "@/lib/khataBillErrors";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import {
  startOrderTracking,
  stopOrderTracking,
  syncHelpAcceptedOrderTracking,
} from "@/lib/vendorBackgroundLocation";
import { sendIveStartedCustomerNotification } from "@/lib/iveStartedNotify";
import {
  hasSentIveStarted,
  shouldShowIveStartedButton,
  shouldStartTrackingOnOrderAccept,
} from "@/lib/vendorTrackingPolicy";

type TrustInfo = {
  trust_score: number;
  total_orders: number;
  is_banned: boolean;
  ban_reason: string | null;
} | null;

type IncomingOrderRow = OrderRequestRow & {
  payment_status?: string;
  payment_utr?: string | null;
};

type OrderBillSummary = {
  id: string;
  total_amount: number;
  payment_mode: "cash" | "upi" | "khata";
  payment_status: string;
  last_vendor_reminder_at?: string | null;
};

type EditBillTarget = {
  billId: string;
  requestId: string;
  userPhone: string | null;
  total_amount: number;
  payment_mode: OrderBillSummary["payment_mode"];
  payment_status: string;
};

/** Page size for incoming-orders fetch; raised from silent 20-cap. */
const INCOMING_PAGE_SIZE = 50;
/** Soft overlap window for appointment cards (± minutes). */
const APPOINTMENT_OVERLAP_WINDOW_MS = 30 * 60 * 1000;

function isActiveAppointmentOrder(
  r: Pick<IncomingOrderRow, "appointment_time" | "status" | "appointment_status">,
): boolean {
  if (!r.appointment_time) return false;
  if (r.status === "cancelled" || r.status === "declined") return false;
  // Decline leaves status='seen'; exclude those from soft overlap.
  if (r.appointment_status === "declined" || r.appointment_status === "cancelled") {
    return false;
  }
  return true;
}

/** Request ids that have another active appointment within ±30 minutes. */
function buildAppointmentOverlapIds(orders: IncomingOrderRow[]): Set<string> {
  const withTime = orders.filter(isActiveAppointmentOrder);
  const ids = new Set<string>();
  for (let i = 0; i < withTime.length; i += 1) {
    const a = withTime[i];
    const tA = new Date(a.appointment_time!).getTime();
    if (!Number.isFinite(tA)) continue;
    for (let j = i + 1; j < withTime.length; j += 1) {
      const b = withTime[j];
      const tB = new Date(b.appointment_time!).getTime();
      if (!Number.isFinite(tB)) continue;
      if (Math.abs(tA - tB) <= APPOINTMENT_OVERLAP_WINDOW_MS) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

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

type Props = {
  vendorId: string;
  serviceMode?: "help" | "delivery" | "appointment" | "booking" | null;
  onUnreadCount?: (n: number) => void;
  /** From the parent's vendor row; replaces a redundant per-mount vendors fetch. */
  shopName: string;
  khataAmberLimit: number;
  khataRedLimit: number;
  cancelReasons: (string | null | undefined)[];
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

function countUnreadIncomingOrders(
  orderList: Pick<OrderRequestRow, "status" | "service_mode" | "delivery_slot" | "appointment_time">[],
  serviceMode: "help" | "delivery" | "appointment" | "booking" | null | undefined,
): number {
  return orderList.filter((r) => {
    const mode = orderEffectiveMode(r, serviceMode);
    if (mode === "delivery" || mode === "appointment" || mode === "booking") {
      return r.status === "sent" || r.status === "seen";
    }
    return r.status === "sent";
  }).length;
}

type LocationHighlightState = { highlightOrderId?: string };

function canShowBillButton(r: OrderRequestRow): boolean {
  if (r.appointment_time) {
    if (r.appointment_status !== "confirmed") return false;
    return r.status === "accepted" || r.status === "fulfilled";
  }
  return r.status === "accepted" || r.status === "fulfilled";
}

export function IncomingOrdersSection({
  vendorId,
  serviceMode,
  onUnreadCount,
  shopName,
  khataAmberLimit,
  khataRedLimit,
  cancelReasons,
}: Props) {
  const location = useLocation();
  const highlightOrderId = (location.state as LocationHighlightState | null)?.highlightOrderId;
  const [flashOrderId, setFlashOrderId] = useState<string | null>(null);
  const isHelpMode = serviceMode === "help";
  const canAddToLedger = serviceMode === "appointment" || serviceMode === "delivery";
  const { s, lang } = useLanguage();
  const appointmentDateLocale =
    lang === "hi" ? "hi-IN" : lang === "mr" ? "mr-IN" : "en-IN";
  const getLabel = useCategoryLabel();
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
  const flagOptions = useMemo(
    () =>
      [
        { value: "noshow" as const, label: s.incoming_flag_reason_noshow },
        { value: "fake" as const, label: s.incoming_flag_reason_fake },
        { value: "abusive" as const, label: s.incoming_flag_reason_abusive },
      ] as const,
    [s],
  );
  const trustBadgeLabels = useMemo(
    () => ({
      newUser: s.incoming_trust_new_user,
      trusted: s.incoming_trust_trusted,
      complaints: s.incoming_trust_complaints,
      risky: s.incoming_trust_risky,
    }),
    [s],
  );
  const [rows, setRows] = useState<IncomingOrderRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [truncatedRemaining, setTruncatedRemaining] = useState(0);
  const fetchLimitRef = useRef(INCOMING_PAGE_SIZE);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const rowActionLockRef = useRef(new Set<string>());
  const cancelOrderLockRef = useRef(new Set<string>());
  const [calledUser, setCalledUser] = useState<Record<string, boolean>>({});
  const [callSheetOpen, setCallSheetOpen] = useState(false);
  const [callTargetPhone, setCallTargetPhone] = useState<string | null>(null);
  const [callServiceMode, setCallServiceMode] = useState<
    "help" | "delivery" | "appointment" | "booking"
  >("help");
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [declineOrderId, setDeclineOrderId] = useState<string | null>(null);
  const [declineUserPhone, setDeclineUserPhone] = useState<string | null>(null);
  const [categoryReasonsById, setCategoryReasonsById] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [categoryBrandById, setCategoryBrandById] = useState<Map<string, string>>(
    () => new Map(),
  );

  const brandForOrder = useCallback(
    (categoryId: string | null | undefined) =>
      resolveCategoryBrandName(
        categoryId ? categoryBrandById.get(categoryId) : null,
        shopName,
        categoryId,
      ) || shopName,
    [categoryBrandById, shopName],
  );

  const activeReasonOrderId = cancelOrderId ?? declineOrderId;
  const activeReasonCategoryId = useMemo(() => {
    if (!activeReasonOrderId) return null;
    const row = rows.find((r) => r.id === activeReasonOrderId);
    return row?.category_id ?? null;
  }, [activeReasonOrderId, rows]);
  const presetReasons = useMemo(
    () =>
      resolveCancelReasonsForCategory(
        activeReasonCategoryId,
        categoryReasonsById,
        cancelReasons,
      ),
    [activeReasonCategoryId, categoryReasonsById, cancelReasons],
  );
  const [declining, setDeclining] = useState(false);
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [otherReasonText, setOtherReasonText] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [billRequestId, setBillRequestId] = useState<string | null>(null);
  const [billUserPhone, setBillUserPhone] = useState<string | null>(null);
  const [billsByRequestId, setBillsByRequestId] = useState<Record<string, OrderBillSummary>>({});
  const [editedBillIds, setEditedBillIds] = useState<Set<string>>(() => new Set());
  const [editBillTarget, setEditBillTarget] = useState<EditBillTarget | null>(null);
  const [historyBillId, setHistoryBillId] = useState<string | null>(null);
  const [markingBillPaidId, setMarkingBillPaidId] = useState<string | null>(null);
  const [remindingBillId, setRemindingBillId] = useState<string | null>(null);
  const remindDebounceUntilRef = useRef<Record<string, number>>({});
  const [addingBillToKhataId, setAddingBillToKhataId] = useState<string | null>(null);
  const [confirmingPaymentId, setConfirmingPaymentId] = useState<string | null>(null);
  const [disputingPaymentId, setDisputingPaymentId] = useState<string | null>(null);
  const [flagOrderId, setFlagOrderId] = useState<string | null>(null);
  const [flagUserPhone, setFlagUserPhone] = useState<string | null>(null);
  const [selectedFlagType, setSelectedFlagType] = useState<
    "noshow" | "fake" | "abusive" | null
  >(null);
  const [flagNotes, setFlagNotes] = useState("");
  const [flagSubmitting, setFlagSubmitting] = useState(false);
  const [flaggedOrderIds, setFlaggedOrderIds] = useState<Record<string, boolean>>({});
  const [trustByPhone, setTrustByPhone] = useState<Record<string, TrustInfo>>({});
  const [requestIdsWithLedger, setRequestIdsWithLedger] = useState<Set<string>>(() => new Set());
  const [requestIdsDismissBlockedByKhata, setRequestIdsDismissBlockedByKhata] = useState<
    Set<string>
  >(() => new Set());
  const [khataOutstandingByPhone, setKhataOutstandingByPhone] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [ledgerOrderId, setLedgerOrderId] = useState<string | null>(null);
  const [ledgerUserPhone, setLedgerUserPhone] = useState<string | null>(null);
  const [ledgerAmount, setLedgerAmount] = useState("");
  const [ledgerOrderNote, setLedgerOrderNote] = useState("");
  const [ledgerVendorNote, setLedgerVendorNote] = useState("");
  const [ledgerSubmitting, setLedgerSubmitting] = useState(false);
  const ledgerSubmitLockRef = useRef(false);
  const [iveStartedTick, setIveStartedTick] = useState(0);
  const mounted = useRef(true);

  /** Batch user-trust lookup: one .in() query for every order's phone. */
  const loadTrustForOrders = useCallback(async (orderList: OrderRequestRow[]) => {
    const phones = [
      ...new Set(
        orderList
          .map((r) => r.user_phone?.trim())
          .filter((p): p is string => !!p),
      ),
    ];
    if (phones.length === 0) {
      setTrustByPhone({});
      return;
    }
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setTrustByPhone({});
      return;
    }
    const { data, error } = await supabase.rpc("get_vendor_customer_trust", {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_phones: phones,
    });
    if (error) {
      captureError(error, { scope: "incomingOrders.loadTrustForOrders", vendorId });
      console.error("loadTrustForOrders", error);
      return;
    }
    const map: Record<string, TrustInfo> = {};
    // Phones with no users row are legitimate new users (trust = null).
    for (const phone of phones) map[phone] = null;
    for (const row of data ?? []) {
      map[row.phone] = {
        trust_score: row.trust_score,
        total_orders: row.total_orders,
        is_banned: row.is_banned,
        ban_reason: row.ban_reason,
      };
    }
    setTrustByPhone(map);
  }, [vendorId]);

  const clearOrderEditedFlag = useCallback(async (orderId: string) => {
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) return;
    const { error } = await supabase.rpc("vendor_clear_order_edited", {
      p_request_id: orderId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });
    if (error) {
      captureError(error, { scope: "incomingOrders.clearOrderEditedFlag", vendorId });
      console.error("clearOrderEditedFlag", error);
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === orderId ? { ...r, is_edited: false } : r)),
    );
  }, [vendorId]);

  const FULFILLED_STALE_MS = 60 * 60 * 1000;

  const mapIncomingOrderRow = useCallback(
    (row: {
      id: string;
      device_id: string;
      vendor_id: string;
      message: string;
      status: string;
      created_at: string;
      user_phone: string | null;
      delivery_address: string | null;
      delivery_slot: string | null;
      appointment_time: string | null;
      appointment_status: string | null;
      cancel_reason: string | null;
      is_edited: boolean | null;
      payment_status: string | null;
      payment_utr: string | null;
      customer_latitude: number | null;
      customer_longitude: number | null;
      category_id: string | null;
      category_label: string | null;
      category_emoji: string | null;
      service_mode?: string | null;
    }): IncomingOrderRow => ({
      id: row.id,
      device_id: row.device_id,
      vendor_id: row.vendor_id,
      message: row.message,
      status: row.status,
      created_at: row.created_at,
      user_phone: row.user_phone,
      delivery_address: row.delivery_address,
      delivery_slot: row.delivery_slot,
      appointment_time: row.appointment_time,
      appointment_status: row.appointment_status,
      cancel_reason: row.cancel_reason,
      is_edited: row.is_edited ?? false,
      payment_status: row.payment_status ?? undefined,
      payment_utr: row.payment_utr,
      customer_latitude: row.customer_latitude,
      customer_longitude: row.customer_longitude,
      category_id: row.category_id,
      service_mode:
        row.service_mode === "help" ||
        row.service_mode === "delivery" ||
        row.service_mode === "appointment"
          ? row.service_mode
          : null,
      categories: row.category_label
        ? { label: row.category_label, emoji: row.category_emoji }
        : null,
    }),
    [],
  );

  const loadBillsForOrders = useCallback(async (requestIds: string[]) => {
    if (requestIds.length === 0) {
      setBillsByRequestId({});
      setEditedBillIds(new Set());
      return;
    }
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setBillsByRequestId({});
      setEditedBillIds(new Set());
      return;
    }
    const { data, error } = await supabase.rpc("get_vendor_order_bills", {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_request_ids: requestIds,
    });
    if (error) {
      // Keep the last-good bill summaries; clearing them here would hide
      // existing bills (false-empty) on a transient RPC failure.
      captureError(error, { scope: "incomingOrders.loadBillsForOrders", vendorId });
      return;
    }

    if (!data?.length) {
      setBillsByRequestId({});
      setEditedBillIds(new Set());
      return;
    }

    const billMap: Record<string, OrderBillSummary> = {};
    const sorted = [...data].sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const bill of sorted) {
      if (!billMap[bill.request_id]) {
        billMap[bill.request_id] = {
          id: bill.id,
          total_amount: bill.total_amount,
          payment_mode: bill.payment_mode as OrderBillSummary["payment_mode"],
          payment_status: bill.payment_status,
          last_vendor_reminder_at: bill.last_vendor_reminder_at ?? null,
        };
      }
    }
    setBillsByRequestId(billMap);
    const edited = await fetchEditedBillIds(
      Object.values(billMap).map((b) => b.id),
      vendorId,
      vendorPhone,
    );
    setEditedBillIds(edited);
  }, [vendorId]);

  const fetchKhataOutstanding = useCallback(
    async (userPhone: string): Promise<number> => {
      const phone = userPhone.trim();
      const vendorPhone = getUserPhone()?.trim();
      if (!phone || !vendorPhone) return 0;
      const { data, error } = await supabase.rpc("get_vendor_khata_ledger", {
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_user_phones: [phone],
      });
      if (error) return 0;
      const row = Array.isArray(data) ? data[0] : null;
      return Number(row?.total_outstanding) || 0;
    },
    [vendorId],
  );

  const mapAddBillToKhataError = (message: string) => {
    if (message.includes("bill_not_unpaid")) {
      toast.error(s.bill_errKhataNotUnpaid);
      return;
    }
    if (message.includes("bill_already_khata")) {
      toast.error(s.bill_errKhataAlready);
      return;
    }
    if (message.includes("customer_phone_required")) {
      toast.error(s.bill_errKhataNoPhone);
      return;
    }
    if (isKhataRedLimitExceededError(message)) {
      toast.error(s.khata_errAlreadyAtRedLimit);
      return;
    }
    if (message.includes("unauthorised")) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    toast.error(message);
  };

  const executeAddBillToKhata = async (
    billId: string,
    requestId: string,
    projectedOutstanding: number,
  ) => {
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    setAddingBillToKhataId(billId);
    const { error } = await supabase.rpc("add_bill_to_khata", {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });
    setAddingBillToKhataId(null);
    if (error) {
      mapAddBillToKhataError(error.message);
      return;
    }
    void loadBillsForOrders(rows.map((row) => row.id));
    toast.success(s.khata_entryAdded);
    if (
      khataAmberLimit > 0 &&
      projectedOutstanding >= khataAmberLimit &&
      (khataRedLimit <= 0 || projectedOutstanding < khataRedLimit)
    ) {
      toast.warning(s.bill_khataLimitWarning);
    }
  };

  const promptAddBillToKhata = async (
    bill: OrderBillSummary,
    requestId: string,
    userPhone: string | null,
  ) => {
    const phone = userPhone?.trim();
    if (!phone) {
      toast.error(s.bill_errKhataNoPhone);
      return;
    }

    let projectedOutstanding = bill.total_amount;
    if (khataAmberLimit > 0 || khataRedLimit > 0) {
      const outstanding = await fetchKhataOutstanding(phone);
      projectedOutstanding = outstanding + bill.total_amount;
    }

    const run = () => void executeAddBillToKhata(bill.id, requestId, projectedOutstanding);

    if (khataRedLimit > 0 && projectedOutstanding >= khataRedLimit) {
      toast.warning(
        s.bill_khataOverLimitConfirm.replace("{customer}", maskPhoneLast4(phone)),
        {
          action: {
            label: s.bill_addToKhata,
            onClick: run,
          },
        },
      );
      return;
    }

    run();
  };

  const markOrderBillPaid = async (billId: string, requestId: string) => {
    setMarkingBillPaidId(billId);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    const { error } = await supabase.rpc("vendor_mark_bill_paid", {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });
    setMarkingBillPaidId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(s.bill_marked_paid);
    setBillsByRequestId((prev) => {
      const bill = prev[requestId];
      if (!bill || bill.id !== billId) return prev;
      return { ...prev, [requestId]: { ...bill, payment_status: "paid" } };
    });
  };

  const remindCustomerAboutBill = async (billId: string, requestId: string) => {
    const debounceUntil = remindDebounceUntilRef.current[billId] ?? 0;
    if (Date.now() < debounceUntil) return;

    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }

    remindDebounceUntilRef.current[billId] = Date.now() + 5000;
    setRemindingBillId(billId);

    const { error } = await supabase.rpc("send_bill_payment_reminder", {
      p_bill_id: billId,
      p_source: "vendor",
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });

    setRemindingBillId(null);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success(s.bill_remind_customer_sent);
    const remindedAt = new Date().toISOString();
    setBillsByRequestId((prev) => {
      const bill = prev[requestId];
      if (!bill || bill.id !== billId) return prev;
      return {
        ...prev,
        [requestId]: { ...bill, last_vendor_reminder_at: remindedAt },
      };
    });
  };

  const isBillRemindDebounced = (billId: string) => {
    const until = remindDebounceUntilRef.current[billId] ?? 0;
    return Date.now() < until;
  };

  const refreshUnpaidKhataDismissBlocks = useCallback(
    async (terminalIds: string[], orderPhones: string[]) => {
      if (khataAmberLimit <= 0) {
        setRequestIdsDismissBlockedByKhata(new Set());
        setKhataOutstandingByPhone(new Map());
        return;
      }

      const normalizedOrderPhones = [
        ...new Set(
          orderPhones
            .map((p) => p?.trim())
            .filter((p): p is string => typeof p === "string" && p.length > 0),
        ),
      ];

      const vendorPhone = getUserPhone()?.trim();
      if (!vendorPhone) {
        setRequestIdsDismissBlockedByKhata(new Set());
        setKhataOutstandingByPhone(new Map());
        return;
      }

      let khataTxs: { request_id: string | null; user_phone: string | null }[] = [];
      if (terminalIds.length > 0) {
        const { data } = await supabase.rpc("get_vendor_khata_dismiss_txs", {
          p_vendor_id: vendorId,
          p_vendor_phone: vendorPhone,
          p_request_ids: terminalIds,
        });
        khataTxs = data ?? [];
      }

      const txPhones = khataTxs
        .map((t) => t.user_phone)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      const phones = [...new Set([...normalizedOrderPhones, ...txPhones])];

      if (phones.length === 0) {
        setRequestIdsDismissBlockedByKhata(new Set());
        setKhataOutstandingByPhone(new Map());
        return;
      }

      const { data: ledgerRows } = await supabase.rpc("get_vendor_khata_ledger", {
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_user_phones: phones,
      });

      const outstandingMap = new Map<string, number>();
      for (const row of ledgerRows ?? []) {
        if (typeof row.user_phone === "string" && row.user_phone.length > 0) {
          outstandingMap.set(row.user_phone, Number(row.total_outstanding) || 0);
        }
      }
      setKhataOutstandingByPhone(outstandingMap);

      if (!khataTxs.length) {
        setRequestIdsDismissBlockedByKhata(new Set());
        return;
      }

      const unpaidPhones = new Set(
        (ledgerRows ?? [])
          .filter((row) => Number(row.total_outstanding) > 0)
          .map((row) => row.user_phone),
      );

      const blocked = new Set(
        khataTxs
          .filter(
            (t) =>
              typeof t.request_id === "string" &&
              t.request_id.length > 0 &&
              t.user_phone != null &&
              unpaidPhones.has(t.user_phone),
          )
          .map((t) => t.request_id as string),
      );

      setRequestIdsDismissBlockedByKhata(blocked);
    },
    [vendorId, khataAmberLimit],
  );

  const autoDismissStaleFulfilledOnLoad = useCallback(
    async (
      orderList: OrderRequestRow[],
      withLedger: Set<string>,
    ): Promise<OrderRequestRow[]> => {
      const now = Date.now();
      const staleFulfilled = orderList.filter((r) => {
        if (r.status !== "fulfilled" || withLedger.has(r.id)) return false;
        const t = new Date(r.created_at).getTime();
        if (!Number.isFinite(t)) return false;
        return now - t > FULFILLED_STALE_MS;
      });

      if (staleFulfilled.length === 0) return orderList;

      const toDismissIds = staleFulfilled.map((r) => r.id);
      const vendorPhone = getUserPhone()?.trim();
      if (!vendorPhone) return orderList;
      const { error } = await supabase.rpc("vendor_dismiss_requests", {
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_request_ids: toDismissIds,
      });

      if (error) return orderList;

      const dismissSet = new Set(toDismissIds);
      return orderList.filter((r) => !dismissSet.has(r.id));
    },
    [vendorId, FULFILLED_STALE_MS],
  );

  const load = useCallback(
    async (opts?: { silent?: boolean; limit?: number }) => {
      const limit = opts?.limit ?? fetchLimitRef.current;
      fetchLimitRef.current = limit;
      if (!opts?.silent) setLoading(true);

      const vendorPhone = getUserPhone()?.trim();
      if (!vendorPhone) {
        if (!mounted.current) return;
        setRows([]);
        setTruncatedRemaining(0);
        onUnreadCount?.(0);
        setLoading(false);
        return;
      }

      const [{ data, error }, { data: totalMatching, error: countError }] = await Promise.all([
        supabase.rpc("get_vendor_incoming_orders", {
          p_vendor_id: vendorId,
          p_vendor_phone: vendorPhone,
          p_limit: limit,
        }),
        supabase.rpc("get_vendor_incoming_orders_count", {
          p_vendor_id: vendorId,
          p_vendor_phone: vendorPhone,
        }),
      ]);
      if (!mounted.current) return;
      if (error || countError) {
        // Preserve the last-good order list instead of blanking it: a transient
        // RPC failure must not look like "no incoming orders".
        captureError(error ?? countError, { scope: "incomingOrders.load", vendorId });
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      setLoadFailed(false);
      const list = (data ?? []).map(mapIncomingOrderRow);
      const total = typeof totalMatching === "number" ? totalMatching : list.length;
      setTruncatedRemaining(Math.max(0, total - list.length));

      const terminalIds = list
        .filter((r) => r.status === "fulfilled" || r.status === "done")
        .map((r) => r.id);
      let withLedger = new Set<string>();
      if (terminalIds.length > 0) {
        const { data: ledgerRows } = await supabase.rpc("get_vendor_khata_request_ids", {
          p_vendor_id: vendorId,
          p_vendor_phone: vendorPhone,
          p_request_ids: terminalIds,
        });
        withLedger = new Set(
          (ledgerRows ?? [])
            .map((row: { request_id: string | null }) => row.request_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        );
      }
      setRequestIdsWithLedger(withLedger);
      await refreshUnpaidKhataDismissBlocks(
        terminalIds,
        list.map((r) => r.user_phone).filter((p): p is string => !!p?.trim()),
      );

      let activeList = await autoDismissStaleFulfilledOnLoad(list, withLedger);
      await loadTrustForOrders(activeList);
      if (!mounted.current) return;
      setRows(activeList);
      void loadBillsForOrders(activeList.map((r) => r.id));
      onUnreadCount?.(countUnreadIncomingOrders(activeList, serviceMode));

      if (!opts?.silent) setLoading(false);

      const hadSent = !isHelpMode && activeList.some((r) => r.status === "sent");
      if (hadSent) {
        const { error: upErr } = await supabase.rpc("vendor_mark_sent_seen", {
          p_vendor_id: vendorId,
          p_vendor_phone: vendorPhone,
        });
        if (upErr || !mounted.current) return;
        const [{ data: refreshed }, { data: refreshedTotal }] = await Promise.all([
          supabase.rpc("get_vendor_incoming_orders", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhone,
            p_limit: fetchLimitRef.current,
          }),
          supabase.rpc("get_vendor_incoming_orders_count", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhone,
          }),
        ]);
        if (!mounted.current) return;
        const mappedRefreshed = (refreshed ?? []).map(mapIncomingOrderRow);
        const refreshedList = mappedRefreshed.length > 0 ? mappedRefreshed : activeList;
        const refreshedTotalN =
          typeof refreshedTotal === "number" ? refreshedTotal : refreshedList.length;
        setTruncatedRemaining(Math.max(0, refreshedTotalN - refreshedList.length));
        const refreshedTerminalIds = refreshedList
          .filter((r) => r.status === "fulfilled" || r.status === "done")
          .map((r) => r.id);
        if (refreshedTerminalIds.length > 0) {
          const { data: ledgerRows } = await supabase.rpc("get_vendor_khata_request_ids", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhone,
            p_request_ids: refreshedTerminalIds,
          });
          withLedger = new Set(
            (ledgerRows ?? [])
              .map((row: { request_id: string | null }) => row.request_id)
              .filter((id): id is string => typeof id === "string" && id.length > 0),
          );
          setRequestIdsWithLedger(withLedger);
        } else {
          setRequestIdsWithLedger(new Set());
        }
        await refreshUnpaidKhataDismissBlocks(
          refreshedTerminalIds,
          refreshedList.map((r) => r.user_phone).filter((p): p is string => !!p?.trim()),
        );
        activeList = await autoDismissStaleFulfilledOnLoad(refreshedList, withLedger);
        await loadTrustForOrders(activeList);
        if (!mounted.current) return;
        setRows(activeList);
        void loadBillsForOrders(activeList.map((r) => r.id));
        onUnreadCount?.(countUnreadIncomingOrders(activeList, serviceMode));
      }
    },
    [
      vendorId,
      onUnreadCount,
      serviceMode,
      isHelpMode,
      mapIncomingOrderRow,
      autoDismissStaleFulfilledOnLoad,
      refreshUnpaidKhataDismissBlocks,
      loadBillsForOrders,
      loadTrustForOrders,
    ],
  );

  useEffect(() => {
    fetchLimitRef.current = INCOMING_PAGE_SIZE;
    setTruncatedRemaining(0);
  }, [vendorId]);

  const loadMoreIncoming = useCallback(async () => {
    if (loadingMore || truncatedRemaining <= 0) return;
    setLoadingMore(true);
    try {
      await load({
        silent: true,
        limit: fetchLimitRef.current + INCOMING_PAGE_SIZE,
      });
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [load, loadingMore, truncatedRemaining]);

  // Poll + Realtime share one refresh entry point so a Realtime-triggered
  // reload suppresses the next poll tick (previously both fired a full
  // load({silent}) independently for the same underlying change).
  const lastSilentRefreshAtRef = useRef(0);
  const silentRefresh = useCallback(() => {
    // Collapse Realtime bursts (e.g. INSERT + UPDATE for one order) into one load.
    if (Date.now() - lastSilentRefreshAtRef.current < 2_000) return;
    lastSilentRefreshAtRef.current = Date.now();
    void load({ silent: true });
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const t = window.setInterval(() => {
      // Skip the poll if Realtime already refreshed within this interval.
      if (Date.now() - lastSilentRefreshAtRef.current < 25_000) return;
      silentRefresh();
    }, 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(t);
    };
  }, [load, silentRefresh]);

  useEffect(() => {
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) return;
    const acceptedHelpIds = rows
      .filter(
        (r) =>
          r.status === "accepted" &&
          orderEffectiveMode(r, serviceMode) === "help",
      )
      .map((r) => r.id);
    syncHelpAcceptedOrderTracking(acceptedHelpIds, { vendorId, vendorPhone });
  }, [rows, vendorId, serviceMode]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [reasonsResult, brandsResult] = await Promise.all([
        supabase
          .from("vendor_category_cancel_reasons")
          .select("category_id, reason_text, position")
          .eq("vendor_id", vendorId)
          .order("position", { ascending: true }),
        supabase
          .from("vendor_categories")
          .select("category_id, brand_name")
          .eq("vendor_id", vendorId)
          .eq("status", "approved"),
      ]);
      if (cancelled) return;
      if (reasonsResult.error) {
        captureError(reasonsResult.error, {
          scope: "incomingOrders.loadCategoryCancelReasons",
          vendorId,
        });
        console.error("loadCategoryCancelReasons", reasonsResult.error);
      } else {
        const map = new Map<string, string[]>();
        for (const row of reasonsResult.data ?? []) {
          const list = map.get(row.category_id) ?? ["", "", "", ""];
          const pos = Number(row.position);
          if (pos >= 1 && pos <= 4) list[pos - 1] = row.reason_text ?? "";
          map.set(row.category_id, list);
        }
        setCategoryReasonsById(map);
      }
      if (!brandsResult.error) {
        const brands = new Map<string, string>();
        for (const row of brandsResult.data ?? []) {
          const brand = String(row.brand_name ?? "").trim();
          if (brand) brands.set(row.category_id, brand);
        }
        setCategoryBrandById(brands);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

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
          silentRefresh();
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
          silentRefresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [vendorId, silentRefresh]);

  const acceptHelpOrder = async (id: string) => {
    void clearOrderEditedFlag(id);
    if (rowActionLockRef.current.has(id)) return;
    rowActionLockRef.current.add(id);
    setMarkingId(id);
    addBreadcrumb("order_accept.start", { request_id: id, acceptKind: "help" });

    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      rowActionLockRef.current.delete(id);
      setMarkingId((current) => (current === id ? null : current));
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    try {
      const { data: accepted, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_accept_order", {
              p_request_id: id,
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
              p_from_status: "sent",
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
        toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
        return;
      }
      if (!accepted) {
        toast.error(s.order_already_taken);
        setRows((prev) => prev.filter((r) => r.id !== id));
        return;
      }
      if (userPhone) {
        void invokeNotifyUser(
          {
            user_phone: userPhone,
            title: s.incoming_helpAcceptedNotifyTitle,
            body: s.incoming_helpAcceptedNotifyBody,
            type: "order_accepted",
            order_id: id,
          },
          { source: "order_accept", request_id: id },
        );
      }
      // Help acceptance does not start order-scoped tracking (case 1 = Go-Live).
      setRows((prev) => {
        const next = prev.map((r) => (r.id === id ? { ...r, status: "accepted" } : r));
        onUnreadCount?.(countUnreadIncomingOrders(next, serviceMode));
        return next;
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void acceptHelpOrder(id), {
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

  const acceptDeliveryOrder = async (id: string, userPhone: string | null) => {
    void clearOrderEditedFlag(id);
    if (rowActionLockRef.current.has(id)) return;
    rowActionLockRef.current.add(id);
    setMarkingId(id);
    addBreadcrumb("order_accept.start", { request_id: id, acceptKind: "delivery" });

    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      rowActionLockRef.current.delete(id);
      setMarkingId((current) => (current === id ? null : current));
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    try {
      const { data: accepted, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_accept_order", {
              p_request_id: id,
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
              p_from_status: "seen",
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
        toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
        return;
      }
      if (!accepted) {
        toast.error(s.order_already_taken);
        void load({ silent: true });
        return;
      }
      const acceptedRow = rows.find((r) => r.id === id);
      if (
        acceptedRow &&
        shouldStartTrackingOnOrderAccept({ ...acceptedRow, status: "accepted" })
      ) {
        const vPhone = vendorPhone;
        void startOrderTracking(id, {
          vendorId,
          vendorPhone: vPhone,
        });
      }
      const phone = userPhone?.trim();
      if (phone) {
        void invokeNotifyUser(
          {
            user_phone: phone,
            title: s.incoming_orderAcceptedTitle,
            body: s.incoming_orderAcceptedBody,
            type: "order_update",
            order_id: id,
          },
          { source: "order_accept", request_id: id },
        );
      }
      void load({ silent: true });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void acceptDeliveryOrder(id, userPhone), {
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

  // One-tap without a confirmation dialog is a deliberate product decision
  // (the next action is obvious to the vendor) — do not add friction here.
  const markDone = async (id: string) => {
    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    setMarkingId(id);
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_fulfil_order", {
              p_request_id: id,
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
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
        if (error.message?.includes("cannot_fulfil_without_bill")) {
          toast.error(s.payment_no_bill_error);
        } else {
          toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
        }
        return;
      }
      if (serviceMode === "delivery") {
        void supabase.rpc("recalculate_vendor_on_time_rate", { p_vendor_id: vendorId });
      }
      if (userPhone) {
        void invokeNotifyUser({
          user_phone: userPhone,
          title: s.incoming_orderFulfilledNotifyTitle,
          body: s.incoming_orderFulfilledNotifyBody,
          type: "order_update",
          order_id: id,
        });
      }
      void stopOrderTracking(id);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "fulfilled" } : r)));
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void markDone(id), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setMarkingId(null);
    }
  };

  // One-tap without a confirmation dialog is a deliberate product decision
  // (the next action is obvious to the vendor) — do not add friction here.
  const confirmPayment = async (
    requestId: string,
    userPhone: string,
    utr: string | null,
    billAmount: number | null,
  ) => {
    setConfirmingPaymentId(requestId);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setConfirmingPaymentId(null);
      toast.error(s.payment_confirm_error);
      return;
    }
    const { error } = await supabase.rpc("confirm_upi_payment", {
      p_request_id: requestId,
      p_vendor_phone: vendorPhone,
    });
    setConfirmingPaymentId(null);
    if (error) {
      captureError(error, { scope: "incomingOrders.confirmPayment", requestId });
      toast.error(s.payment_confirm_error);
      return;
    }
    toast.success(s.payment_confirm_success);
    setRows((prev) =>
      prev.map((r) => (r.id === requestId ? { ...r, payment_status: "confirmed" } : r)),
    );
    if (userPhone) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.payment_confirmed_notify_title,
        body: s.payment_confirmed_notify_body.replace(
          "{amount}",
          billAmount ? billAmount.toFixed(2) : "",
        ),
        type: "payment_confirmed",
        order_id: requestId,
        route: "my-orders",
        route_params: { order_id: requestId },
      });
    }
  };

  const disputePayment = async (requestId: string, userPhone: string) => {
    setDisputingPaymentId(requestId);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setDisputingPaymentId(null);
      toast.error(s.payment_dispute_error);
      return;
    }
    const { error } = await supabase.rpc("dispute_upi_payment", {
      p_request_id: requestId,
      p_vendor_phone: vendorPhone,
    });
    setDisputingPaymentId(null);
    if (error) {
      captureError(error, { scope: "incomingOrders.disputePayment", requestId });
      toast.error(s.payment_dispute_error);
      return;
    }
    toast.success(s.payment_dispute_success);
    setRows((prev) =>
      prev.map((r) => (r.id === requestId ? { ...r, payment_status: "disputed" } : r)),
    );
    if (userPhone) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.payment_disputed_notify_title,
        body: s.payment_disputed_notify_body,
        type: "payment_disputed",
        order_id: requestId,
        route: "my-orders",
        route_params: { order_id: requestId },
      });
    }
  };

  // One-tap without a confirmation dialog is a deliberate product decision
  // (the next action is obvious to the vendor) — do not add friction here.
  const dismissOrder = async (id: string) => {
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    setMarkingId(id);
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_dismiss_requests", {
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
              p_request_ids: [id],
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
        toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void dismissOrder(id), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setMarkingId(null);
    }
  };

  const handleAppointmentAction = async (id: string, action: "confirmed" | "declined") => {
    if (action === "declined") return;
    if (rowActionLockRef.current.has(id)) return;
    rowActionLockRef.current.add(id);
    setMarkingId(id);

    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      rowActionLockRef.current.delete(id);
      setMarkingId((current) => (current === id ? null : current));
      toast.error(s.incoming_errCouldNotUpdateAppt);
      return;
    }
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_confirm_appointment", {
              p_request_id: id,
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
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
        captureError(error, {
          scope: "incomingOrders.confirmAppointment",
          vendorId,
          requestId: id,
        });
        console.error("handleAppointmentAction", action, error);
        const msg = error.message ?? "";
        if (msg.includes("already_actioned")) {
          toast.info(s.incoming_apptAlreadyActioned);
          void load({ silent: true });
          return;
        }
        toast.error(s.incoming_errCouldNotUpdateAppt, { description: error.message });
        return;
      }
      if (userPhone) {
        void invokeNotifyUser({
          user_phone: userPhone,
          title: s.incoming_bookingConfirmedNotifyTitle,
          body: s.incoming_bookingConfirmedNotifyBody,
          type: "order_update",
          order_id: id,
        });
      }
      const confirmedRow = rows.find((r) => r.id === id);
      if (
        confirmedRow &&
        shouldStartTrackingOnOrderAccept({
          ...confirmedRow,
          status: "accepted",
          appointment_status: "confirmed",
        })
      ) {
        void startOrderTracking(id, {
          vendorId,
          vendorPhone,
        });
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, appointment_status: action, status: "accepted" } : r,
        ),
      );
      toast.success(s.incoming_apptConfirmed);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleAppointmentAction(id, action), {
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

  const handleIveStarted = async (order: IncomingOrderRow) => {
    // Cases 4 & 5 — notification only; sendIveStartedCustomerNotification never starts tracking.
    const result = await sendIveStartedCustomerNotification({
      order,
      userPhone: order.user_phone,
    });
    if (result.ok === false) {
      if (result.reason === "no_phone") {
        toast.error(s.incoming_errCouldNotUpdate);
      }
      return;
    }
    setIveStartedTick((n) => n + 1);
    toast.success(s.incoming_iveStarted_sent);
  };

  const closeDeclineSheet = () => {
    setDeclineOrderId(null);
    setDeclineUserPhone(null);
    setSelectedReason(null);
    setOtherReasonText("");
  };

  const handleCallCustomer = (phone: string, mode: string) => {
    setCallTargetPhone(phone);
    setCallServiceMode(
      mode as "help" | "delivery" | "appointment" | "booking",
    );
    setCallSheetOpen(true);
  };

  const callBridgeVendor = useMemo((): AiBridgeVendor | null => {
    if (!callTargetPhone) return null;
    return {
      id: `customer-${callTargetPhone}`,
      name: s.incoming_customer,
      shop_name: s.incoming_customer,
      category: s.incoming_customer,
      vendor_note: null,
      phone: callTargetPhone,
      service_mode: callServiceMode,
      verification_status: "unverified",
      is_manual_verified: false,
      total_helped: 0,
      on_time_rate: null,
    };
  }, [callTargetPhone, callServiceMode, s.incoming_customer]);

  const confirmDeclineBooking = async () => {
    if (!declineOrderId || !selectedReason) return;
    if (rowActionLockRef.current.has(declineOrderId)) return;

    void clearOrderEditedFlag(declineOrderId);
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const userPhone =
      declineUserPhone?.trim() ||
      rows.find((r) => r.id === declineOrderId)?.user_phone?.trim() ||
      "";

    rowActionLockRef.current.add(declineOrderId);
    setDeclining(true);
    setMarkingId(declineOrderId);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      rowActionLockRef.current.delete(declineOrderId);
      setDeclining(false);
      setMarkingId((current) => (current === declineOrderId ? null : current));
      toast.error(s.incoming_errCouldNotUpdateAppt);
      return;
    }
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_decline_booking", {
              p_request_id: declineOrderId,
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
              p_cancel_reason: reasonText,
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
        captureError(error, {
          scope: "incomingOrders.declineBooking",
          vendorId,
          requestId: declineOrderId,
        });
        console.error("confirmDeclineBooking", error);
        const msg = error.message ?? "";
        if (msg.includes("already_actioned")) {
          toast.info(s.incoming_apptAlreadyActioned);
          closeDeclineSheet();
          void load({ silent: true });
          return;
        }
        toast.error(s.incoming_errCouldNotUpdateAppt, { description: error.message });
        return;
      }
      if (userPhone) {
        const title = s.incoming_bookingDeclinedNotifyTitle;
        const body = s.incoming_bookingDeclinedNotifyBody(reasonText);
        void invokeNotifyUser({
          user_phone: userPhone,
          title,
          body,
          type: "order_update",
          order_id: declineOrderId,
        });
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === declineOrderId
            ? {
                ...r,
                appointment_status: "declined",
                status: "seen",
                cancel_reason: reasonText,
              }
            : r,
        ),
      );
      closeDeclineSheet();
      toast.success(s.incoming_apptDeclined);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void confirmDeclineBooking(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      rowActionLockRef.current.delete(declineOrderId);
      setDeclining(false);
      setMarkingId((current) => (current === declineOrderId ? null : current));
    }
  };

  const closeCancelSheet = () => {
    setCancelOrderId(null);
    setSelectedReason(null);
    setOtherReasonText("");
  };

  const openLedgerSheet = (order: OrderRequestRow) => {
    if (!order.user_phone) return;
    setLedgerOrderId(order.id);
    setLedgerUserPhone(order.user_phone);
    setLedgerAmount("");
    setLedgerOrderNote(stripLocationTag(order.message ?? "").trim());
    setLedgerVendorNote("");
  };

  const closeLedgerSheet = () => {
    setLedgerOrderId(null);
    setLedgerUserPhone(null);
    setLedgerAmount("");
    setLedgerOrderNote("");
    setLedgerVendorNote("");
  };

  useEffect(() => {
    if (ledgerOrderId == null) return;
    // Force repaint on Android WebView
    requestAnimationFrame(() => {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
    });
  }, [ledgerOrderId]);

  const confirmLedgerEntry = async () => {
    if (!ledgerOrderId || !ledgerUserPhone) return;
    const amount = parseFloat(ledgerAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (ledgerSubmitLockRef.current) return;

    // Sync lock before React re-render so rapid multi-tap cannot re-enter.
    ledgerSubmitLockRef.current = true;
    setLedgerSubmitting(true);

    const releaseLedgerSubmitLock = () => {
      ledgerSubmitLockRef.current = false;
      setLedgerSubmitting(false);
    };

    try {
      const vendorNote = ledgerVendorNote.trim();

      const { data: billId, error } = await supabase.rpc("insert_bill_with_items", {
        p_order_id: ledgerOrderId,
        p_vendor_id: vendorId,
        p_customer_phone: ledgerUserPhone,
        p_total: amount,
        p_payment_mode: "khata",
        p_payment_status: "unpaid",
        p_notes: vendorNote || null,
        p_items: [
          {
            name: vendorNote || s.khata_defaultItemName,
            quantity: 1,
            unit_price: amount,
            unit: null,
          },
        ],
      });

      if (error || !billId) {
        toast.error(
          messageForKhataChargeError(
            error?.message,
            s.khata_errAlreadyAtRedLimit,
            error?.message || s.bill_sendFailed,
          ),
        );
        return;
      }

      const terminalIds = rows
        .filter((r) => r.status === "fulfilled" || r.status === "done")
        .map((r) => r.id);
      await refreshUnpaidKhataDismissBlocks(
        terminalIds,
        rows.map((r) => r.user_phone).filter((p): p is string => !!p?.trim()),
      );

      setRequestIdsWithLedger((prev) => new Set(prev).add(ledgerOrderId));
      void loadBillsForOrders(rows.map((r) => r.id));
      closeLedgerSheet();
      toast.success(s.khata_entryAdded);
    } finally {
      releaseLedgerSubmitLock();
    }
  };

  const openFlagSheet = (order: OrderRequestRow) => {
    if (!order.user_phone) return;
    setFlagOrderId(order.id);
    setFlagUserPhone(order.user_phone);
    setSelectedFlagType(null);
    setFlagNotes("");
  };

  const closeFlagSheet = () => {
    setFlagOrderId(null);
    setFlagUserPhone(null);
    setSelectedFlagType(null);
    setFlagNotes("");
  };

  const submitFlagReport = async () => {
    if (!flagOrderId || !flagUserPhone || !selectedFlagType) return;

    setFlagSubmitting(true);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setFlagSubmitting(false);
      return;
    }
    const { error } = await supabase.rpc("vendor_submit_user_flag", {
      p_request_id: flagOrderId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: flagUserPhone,
      p_flag_type: selectedFlagType,
      p_notes: flagNotes.trim() || null,
    });
    setFlagSubmitting(false);

    if (error) {
      captureError(error, { scope: "incomingOrders.submitFlagReport", vendorId });
      console.error("submitFlagReport", error);
      return;
    }

    void invokecalculateTrustScore(flagUserPhone);
    setFlaggedOrderIds((prev) => ({ ...prev, [flagOrderId]: true }));
    closeFlagSheet();
    toast.success(s.incoming_flag_report_submitted);
  };

  const confirmCancelOrder = async () => {
    if (!cancelOrderId || !selectedReason) return;
    if (cancelOrderLockRef.current.has(cancelOrderId)) return;

    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const order = rows.find((r) => r.id === cancelOrderId);
    const isAppointmentOrder =
      order?.appointment_status === "confirmed" || !!order?.appointment_time;

    cancelOrderLockRef.current.add(cancelOrderId);
    setCancelling(true);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      cancelOrderLockRef.current.delete(cancelOrderId);
      setCancelling(false);
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }

    try {
      const { error } = await supabase.rpc("vendor_cancel_order", {
        p_request_id: cancelOrderId,
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_cancel_reason: reasonText,
        p_cancel_appointment: isAppointmentOrder,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      void stopOrderTracking(cancelOrderId);
      const userPhone = rows.find((r) => r.id === cancelOrderId)?.user_phone?.trim();
      if (userPhone) {
        const title = s.incoming_orderCancelledNotifyTitle;
        const body = s.incoming_orderCancelledNotifyBody(reasonText);
        void invokeNotifyUser({
          user_phone: userPhone,
          title,
          body,
          type: "order_update",
          order_id: cancelOrderId,
        });
      }
      toast.success(s.orderCancelled);
      setRows((prev) =>
        prev.map((r) =>
          r.id === cancelOrderId
            ? {
                ...r,
                status: "cancelled",
                cancel_reason: reasonText,
                ...(isAppointmentOrder ? { appointment_status: "cancelled" as const } : {}),
              }
            : r,
        ),
      );
      closeCancelSheet();
    } finally {
      cancelOrderLockRef.current.delete(cancelOrderId);
      setCancelling(false);
    }
  };

  const unread = countUnreadIncomingOrders(rows, serviceMode);

  const appointmentOverlapIds = useMemo(() => buildAppointmentOverlapIds(rows), [rows]);

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase().trim();
    return rows.filter(
      (r) =>
        r.user_phone?.includes(q) ||
        r.message?.toLowerCase().includes(q) ||
        r.status?.toLowerCase().includes(q) ||
        r.delivery_address?.toLowerCase().includes(q),
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

  const acceptedStatusLabel = (r: Pick<OrderRequestRow, "appointment_status" | "status">): string => {
    if (serviceMode !== "appointment") {
      return s.status_accepted;
    }
    return r.appointment_status === "confirmed"
      ? s.status_accepted_appointment_confirmed
      : s.status_accepted_appointment_awaiting;
  };

  const badge = (r: Pick<OrderRequestRow, "status" | "appointment_status">) => {
    const status = r.status;
    if (status === "sent")
      return (
        <span
          data-testid="incoming-order-status"
          className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-bold px-2 py-0.5 border border-brand/40"
        >
          {s.incoming_statusNew}
        </span>
      );
    if (status === "seen")
      return (
        <span
          data-testid="incoming-order-status"
          className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border"
        >
          {s.incoming_statusSeen}
        </span>
      );
    if (status === "accepted")
      return (
        <span
          data-testid="incoming-order-status"
          className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-semibold px-2 py-0.5 border border-brand/40"
        >
          {acceptedStatusLabel(r)}
        </span>
      );
    if (status === "fulfilled")
      return (
        <span
          data-testid="incoming-order-status"
          className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand"
        >
          {s.incoming_statusDone}
        </span>
      );
    if (status === "cancelled")
      return (
        <span
          data-testid="incoming-order-status"
          className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border"
        >
          {s.orderCancelled}
        </span>
      );
    return (
      <span
        data-testid="incoming-order-status"
        className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand"
      >
        {s.incoming_statusDone}
      </span>
    );
  };

  const shouldShowStatusBadge = (r: OrderRequestRow) => {
    if (r.appointment_status === "declined") return false;
    if (r.status === "cancelled" || r.status === "fulfilled" || r.status === "done") {
      return false;
    }
    return true;
  };

  return (
    <div
      className="mx-4 rounded-2xl border border-surface-border bg-surface overflow-hidden"
      data-testid="incoming-orders-section"
      data-loading={String(loading)}
    >
      <div className="px-4 py-3 flex items-center justify-between border-b border-surface-border">
        <span className="text-sm font-bold uppercase tracking-wide text-foreground">
          {s.incoming_heading}
        </span>
        {unread > 0 && (
          <span className="bg-brand text-white text-xs font-bold px-2 py-0.5 rounded-full tabular-nums">
            {unread > 99 ? s.incoming_unreadCap : unread}
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
      {rows.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={s.search_ordersPlaceholder}
            className="w-full bg-surface border border-surface-border rounded-xl pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
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
      )}

      {loadFailed && (
        <NetworkErrorBanner
          status="failed"
          onRetry={() => void load()}
          className="mb-0"
        />
      )}

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        !loadFailed && (
          <p className="text-sm text-muted-foreground text-center py-4">{s.incoming_empty}</p>
        )
      ) : searchQuery.trim() && filteredRows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {s.search_noResults}
        </div>
      ) : (
        <ul className="space-y-3">
          {filteredRows.map((r) => {
            const orderMode = orderEffectiveMode(r, serviceMode);
            const orderIsHelp = orderMode === "help";
            const orderCanAddToLedger =
              orderMode === "appointment" || orderMode === "delivery" || orderMode === "booking";
            return (
            <li
              key={r.id}
              id={`order-card-${r.id}`}
              data-testid="incoming-order-card"
              className={cn(
                "rounded-xl border border-border bg-muted/30 p-3 space-y-2",
                flashOrderId === r.id &&
                  "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse",
              )}
              onClick={() => void clearOrderEditedFlag(r.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatTimeAgo(r.created_at)}
                </span>
                {shouldShowStatusBadge(r) && badge(r)}
              </div>
              {(() => {
                const cat = Array.isArray(r.categories) ? r.categories[0] : r.categories;
                if (!cat?.label) return null;
                return (
                  <span
                    data-testid="incoming-order-category"
                    className="inline-flex items-center gap-0.5 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-foreground w-fit"
                  >
                    {cat.emoji ? <span aria-hidden>{cat.emoji}</span> : null}
                    <span>{getLabel(cat.label)}</span>
                  </span>
                );
              })()}
              <div className="flex items-start gap-2">
                <p className="flex-1 min-w-0 text-sm text-foreground leading-snug whitespace-pre-wrap break-words">
                  {stripLocationTag(r.message)}
                </p>
                {r.is_edited && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold px-2 py-0.5 border border-amber-500/30">
                    {s.order_edited_badge}
                  </span>
                )}
              </div>
              {r.user_phone && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {maskPhoneLast4(r.user_phone.trim())}
                  </span>
                  {khataAmberLimit > 0 &&
                    (() => {
                      const phone = r.user_phone.trim();
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
                            "inline-flex rounded-full text-[10px] font-semibold px-2 py-0.5 border",
                            creditBadge.className,
                          )}
                        >
                          {creditBadge.label}
                        </span>
                      );
                    })()}
                  {(() => {
                    const trustBadge = getUserTrustBadge(
                      trustByPhone[r.user_phone.trim()],
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
              {r.status === "cancelled" && r.cancel_reason && (
                <span className="inline-flex rounded-full bg-muted text-muted-foreground text-[10px] font-medium px-2 py-0.5 border border-border">
                  {r.cancel_reason}
                </span>
              )}
              {r.delivery_address && (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  {s.incoming_addressPrefix}<span className="text-foreground font-medium">{r.delivery_address}</span>
                </div>
              )}

              {(() => {
                const mapsUrl = resolveVendorNavigateToCustomerUrl(orderMode, r);
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
                const slot = deliverySlotLabel(r.delivery_slot, slotLabels);
                if (!slot) return null;
                return (
                  <div className="rounded-lg border border-brand-border bg-brand/5 px-3 py-2 text-[11px]">
                    {s.incoming_slotPrefix}<span className="text-green-700 dark:text-brand font-semibold">{slot}</span>
                  </div>
                );
              })()}

              {r.appointment_time &&
                (() => {
                  const msg = r.message ?? "";
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
                          {new Date(r.appointment_time).toLocaleString(appointmentDateLocale, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {appointmentOverlapIds.has(r.id) && (
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

              {r.appointment_time && r.appointment_status === "pending" && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="incoming-accept-btn"
                    disabled={markingId === r.id}
                    onClick={() => void handleAppointmentAction(r.id, "confirmed")}
                    className="min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {s.incoming_btnConfirm}
                  </button>
                  <button
                    type="button"
                    data-testid="incoming-decline-btn"
                    disabled={markingId === r.id}
                    onClick={() => {
                      setDeclineOrderId(r.id);
                      setDeclineUserPhone(r.user_phone?.trim() || null);
                      setSelectedReason(null);
                      setOtherReasonText("");
                    }}
                    className="rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {s.incoming_btnDecline}
                  </button>
                </div>
              )}

              {r.appointment_time &&
                r.appointment_status === "confirmed" &&
                r.status !== "cancelled" && (
                <>
                  {r.status !== "fulfilled" && r.status !== "done" && (
                    <span
                      data-testid="incoming-order-status"
                      className="inline-flex rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-semibold px-2 py-0.5 border border-brand/40"
                    >
                      {s.incoming_bookingConfirmed}
                    </span>
                  )}
                  {r.status !== "done" &&
                    r.status !== "fulfilled" &&
                    r.status !== "cancelled" && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            setCancelOrderId(r.id);
                            setSelectedReason(null);
                            setOtherReasonText("");
                          }}
                          className="w-full rounded-lg border border-destructive/50 text-destructive text-xs font-semibold py-2 active:scale-[0.99]"
                        >
                          {s.incoming_cancelBooking}
                        </button>
                        {(() => {
                          void iveStartedTick;
                          const showIve = shouldShowIveStartedButton(r);
                          const sent = hasSentIveStarted(r.id);
                          if (!showIve && !sent) return null;
                          return (
                            <button
                              type="button"
                              data-testid="incoming-ive-started-btn"
                              disabled={sent}
                              onClick={() => void handleIveStarted(r)}
                              className="w-full rounded-lg border border-brand/50 bg-brand/10 text-brand text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                            >
                              {sent ? s.incoming_iveStarted_sent : s.incoming_iveStarted_btn}
                            </button>
                          );
                        })()}
                        {r.user_phone && (
                          <button
                            type="button"
                            onClick={() =>
                              handleCallCustomer(r.user_phone!, orderMode)
                            }
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                            aria-label={s.incoming_callCustomer}
                          >
                            📞 {s.incoming_callCustomer}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid="incoming-done-btn"
                          disabled={markingId === r.id}
                          onClick={() => void markDone(r.id)}
                          className="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                        >
                          {markingId === r.id ? s.incoming_saving : s.incoming_markDone}
                        </button>
                      </div>
                    )}
                </>
              )}

              {r.appointment_time && r.appointment_status === "declined" && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive font-semibold text-center">
                  {s.incoming_bannerDeclined}
                </div>
              )}

              {(r.status === "cancelled" || r.appointment_status === "declined") && (
                <button
                  type="button"
                  disabled={markingId === r.id}
                  onClick={() => void dismissOrder(r.id)}
                  className="w-full rounded-lg border border-border bg-muted/40 text-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === r.id ? s.incoming_saving : s.incoming_dismiss}
                </button>
              )}

              {!r.appointment_time && orderIsHelp && r.status === "sent" && (
                  <button
                    type="button"
                    data-testid="incoming-accept-btn"
                    disabled={markingId === r.id}
                    onClick={() => void acceptHelpOrder(r.id)}
                    className="w-full min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {markingId === r.id ? s.incoming_saving : s.incoming_btnAccept}
                  </button>
                )}

              {!r.appointment_time && !orderIsHelp && r.status === "seen" && (
                <button
                  type="button"
                  data-testid="incoming-accept-btn"
                  disabled={markingId === r.id}
                  onClick={() => void acceptDeliveryOrder(r.id, r.user_phone ?? null)}
                  className="w-full min-h-[44px] rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                >
                  {markingId === r.id ? s.incoming_saving : s.incoming_acceptOrder}
                </button>
              )}

              {!r.appointment_time && (
                <>
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
                  {r.status === "accepted" && (
                    <>
                      {(() => {
                        void iveStartedTick;
                        const showIve = shouldShowIveStartedButton(r);
                        const sent = hasSentIveStarted(r.id);
                        if (!showIve && !sent) return null;
                        return (
                          <button
                            type="button"
                            data-testid="incoming-ive-started-btn"
                            disabled={sent}
                            onClick={() => void handleIveStarted(r)}
                            className="w-full rounded-lg border border-brand/50 bg-brand/10 text-brand text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                          >
                            {sent ? s.incoming_iveStarted_sent : s.incoming_iveStarted_btn}
                          </button>
                        );
                      })()}
                      {r.user_phone && (
                        <button
                          type="button"
                          onClick={() =>
                            handleCallCustomer(r.user_phone!, orderMode)
                          }
                          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-brand text-brand text-sm font-medium"
                          aria-label={s.incoming_callCustomer}
                        >
                          📞 {s.incoming_callCustomer}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="incoming-done-btn"
                        disabled={markingId === r.id}
                        onClick={() => void markDone(r.id)}
                        className="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                      >
                        {markingId === r.id ? s.incoming_saving : s.incoming_markDone}
                      </button>
                    </>
                  )}
                  {(r.status === "fulfilled" || r.status === "cancelled") &&
                    r.user_phone &&
                    !flaggedOrderIds[r.id] && (
                      <button
                        type="button"
                        onClick={() => openFlagSheet(r)}
                        className="w-full text-left text-[11px] text-muted-foreground/80 hover:text-muted-foreground py-1"
                      >
                        {s.incoming_flag_report_btn}
                      </button>
                    )}
                </>
              )}

              {canShowBillButton(r) && (
                <>
                  {(() => {
                    const existingBill = billsByRequestId[r.id];
                    return (
                      <button
                        type="button"
                        data-testid="incoming-bill-btn"
                        onClick={() => {
                          if (existingBill) {
                            document
                              .getElementById(`incoming-bill-preview-${r.id}`)
                              ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                            return;
                          }
                          setBillRequestId(r.id);
                          setBillUserPhone(r.user_phone);
                        }}
                        className="w-full rounded-xl border border-primary/50 text-primary text-sm font-semibold py-2.5 active:scale-[0.99]"
                      >
                        {existingBill ? s.bill_view_title : s.bill_title}
                      </button>
                    );
                  })()}
                  {billsByRequestId[r.id] && (
                    <div
                      id={`incoming-bill-preview-${r.id}`}
                      data-testid="incoming-bill-preview"
                      className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-xs font-semibold text-foreground">
                            {s.bill_total}: ₹{billsByRequestId[r.id].total_amount.toFixed(2)}
                          </p>
                          {editedBillIds.has(billsByRequestId[r.id].id) && (
                            <button
                              type="button"
                              data-testid="incoming-bill-edited-badge"
                              onClick={() => setHistoryBillId(billsByRequestId[r.id].id)}
                              className="text-[10px] font-semibold text-brand underline shrink-0"
                            >
                              {s.bill_editedBadge}
                            </button>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {billsByRequestId[r.id].payment_mode === "cash"
                            ? s.bill_cash
                            : billsByRequestId[r.id].payment_mode === "upi"
                              ? s.bill_upi
                              : s.bill_khata}
                          {" · "}
                          {billsByRequestId[r.id].payment_status === "paid"
                            ? s.bill_statusPaid
                            : s.bill_statusUnpaid}
                        </span>
                      </div>
                      {(billsByRequestId[r.id].payment_mode === "cash" ||
                        billsByRequestId[r.id].payment_mode === "upi") &&
                        billsByRequestId[r.id].payment_status === "unpaid" && (
                          <button
                            type="button"
                            disabled={markingBillPaidId === billsByRequestId[r.id].id}
                            onClick={() =>
                              void markOrderBillPaid(billsByRequestId[r.id].id, r.id)
                            }
                            className="w-full rounded-lg bg-brand/15 text-brand border border-brand/40 text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {markingBillPaidId === billsByRequestId[r.id].id
                              ? s.incoming_saving
                              : s.khata_markPaid}
                          </button>
                        )}
                      {billsByRequestId[r.id].payment_status === "unpaid" && (
                        <>
                          <button
                            type="button"
                            data-testid="incoming-remind-customer-btn"
                            disabled={
                              remindingBillId === billsByRequestId[r.id].id ||
                              isBillRemindDebounced(billsByRequestId[r.id].id)
                            }
                            onClick={() =>
                              void remindCustomerAboutBill(
                                billsByRequestId[r.id].id,
                                r.id,
                              )
                            }
                            className="w-full rounded-lg border border-amber-500/50 text-amber-500 text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {remindingBillId === billsByRequestId[r.id].id
                              ? s.bill_remind_customer_sending
                              : s.bill_remind_customer}
                          </button>
                          {billsByRequestId[r.id].last_vendor_reminder_at && (
                            <p
                              data-testid="incoming-last-reminded"
                              className="text-[10px] text-muted-foreground text-center"
                            >
                              {s.bill_remind_customer_last.replace(
                                "{when}",
                                formatTimeAgo(billsByRequestId[r.id].last_vendor_reminder_at!),
                              )}
                            </p>
                          )}
                        </>
                      )}
                      {billsByRequestId[r.id].payment_status === "unpaid" &&
                        billsByRequestId[r.id].payment_mode !== "khata" && (
                          <button
                            type="button"
                            data-testid="incoming-add-bill-to-khata-btn"
                            disabled={addingBillToKhataId === billsByRequestId[r.id].id}
                            onClick={() =>
                              void promptAddBillToKhata(
                                billsByRequestId[r.id],
                                r.id,
                                r.user_phone,
                              )
                            }
                            className="w-full rounded-lg border border-primary/50 text-primary text-xs font-semibold py-2 disabled:opacity-50"
                          >
                            {addingBillToKhataId === billsByRequestId[r.id].id
                              ? s.incoming_saving
                              : s.bill_addToKhata}
                          </button>
                        )}
                      {billsByRequestId[r.id].payment_status !== "void" && (
                        <button
                          type="button"
                          data-testid="incoming-edit-bill-btn"
                          onClick={() =>
                            setEditBillTarget({
                              billId: billsByRequestId[r.id].id,
                              requestId: r.id,
                              userPhone: r.user_phone,
                              total_amount: billsByRequestId[r.id].total_amount,
                              payment_mode: billsByRequestId[r.id].payment_mode,
                              payment_status: billsByRequestId[r.id].payment_status,
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

              {(r.status === "fulfilled" || r.status === "done") && (
                <div className="space-y-2">
                  {orderCanAddToLedger &&
                    r.user_phone &&
                    !requestIdsWithLedger.has(r.id) &&
                    !billsByRequestId[r.id] && (
                    <button
                      type="button"
                      onClick={() => openLedgerSheet(r)}
                      className="w-full rounded-lg border border-primary/50 text-primary text-xs font-semibold py-2 active:scale-[0.99]"
                    >
                      {s.khata_addToLedger}
                    </button>
                  )}
                  {(() => {
                    const dismissBlockedByKhata = requestIdsDismissBlockedByKhata.has(r.id);
                    return (
                      <div>
                        <button
                          type="button"
                          disabled={markingId === r.id || dismissBlockedByKhata}
                          onClick={() => {
                            if (!dismissBlockedByKhata) void dismissOrder(r.id);
                          }}
                          className={cn(
                            "w-full rounded-lg border border-border bg-muted/40 text-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50",
                            dismissBlockedByKhata && "opacity-50 cursor-not-allowed",
                          )}
                        >
                          {markingId === r.id ? s.incoming_saving : s.incoming_dismiss}
                        </button>
                        {dismissBlockedByKhata && (
                          <p className="text-[10px] text-muted-foreground text-center mt-1">
                            {s.khata_settleDuesFirst}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {r.payment_status === "claimed" && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="incoming-confirm-payment-btn"
                    disabled={confirmingPaymentId === r.id || disputingPaymentId === r.id}
                    onClick={() =>
                      void confirmPayment(
                        r.id,
                        r.user_phone?.trim() || "",
                        r.payment_utr ?? null,
                        billsByRequestId[r.id]?.total_amount ?? null,
                      )
                    }
                    className="rounded-lg border border-green-500/50 text-green-600 dark:text-green-400 text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {confirmingPaymentId === r.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {s.payment_confirm_btn}
                  </button>
                  <button
                    type="button"
                    data-testid="dispute-payment-btn"
                    disabled={confirmingPaymentId === r.id || disputingPaymentId === r.id}
                    onClick={() =>
                      void disputePayment(r.id, r.user_phone?.trim() || "")
                    }
                    className="rounded-lg border border-red-500/50 text-red-500 text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {disputingPaymentId === r.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {s.payment_dispute_btn}
                  </button>
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {truncatedRemaining > 0 && !searchQuery.trim() && (
        <div className="pt-1" data-testid="incoming-orders-truncated">
          <button
            type="button"
            data-testid="incoming-orders-load-more"
            disabled={loadingMore}
            onClick={() => void loadMoreIncoming()}
            className="w-full rounded-xl border border-border bg-muted/40 py-2.5 text-sm font-semibold text-foreground disabled:opacity-50"
          >
            {loadingMore
              ? s.incoming_loadingMore
              : s.incoming_loadMore.replace("{count}", String(truncatedRemaining))}
          </button>
        </div>
      )}

      <Sheet open={flagOrderId != null} onOpenChange={(open) => !open && closeFlagSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>{s.incoming_flag_report_title}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <RadioGroup
              value={selectedFlagType ?? ""}
              onValueChange={(value) =>
                setSelectedFlagType(value as "noshow" | "fake" | "abusive")
              }
            >
              {flagOptions.map((opt) => (
                <div key={opt.value} className="flex items-start gap-3">
                  <RadioGroupItem
                    value={opt.value}
                    id={`flag-${opt.value}`}
                    className="mt-0.5"
                  />
                  <label
                    htmlFor={`flag-${opt.value}`}
                    className="text-sm text-foreground leading-snug cursor-pointer"
                  >
                    {opt.label}
                  </label>
                </div>
              ))}
            </RadioGroup>
            <div>
              <label
                htmlFor="flag-notes"
                className="text-xs text-muted-foreground block mb-1.5"
              >
                {s.incoming_flag_notes_label}
              </label>
              <textarea
                id="flag-notes"
                value={flagNotes}
                onChange={(e) => setFlagNotes(e.target.value.slice(0, 200))}
                maxLength={200}
                rows={2}
                placeholder={s.incoming_flag_notes_placeholder}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="button"
              data-testid="incoming-flag-submit"
              disabled={flagSubmitting || !selectedFlagType}
              onClick={() => void submitFlagReport()}
              className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
            >
              {flagSubmitting ? s.incoming_saving : s.incoming_flag_submit}
            </button>
          </div>
        </SheetContent>
      </Sheet>

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

      <Sheet open={ledgerOrderId != null} onOpenChange={(open) => !open && closeLedgerSheet()}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl max-h-[90vh] flex flex-col"
          style={{
            transform: "translateZ(0)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <SheetHeader className="text-left">
            <SheetTitle>{s.khata_addToLedgerTitle}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">
                {s.incoming_ledger_customer_phone}
              </label>
              <p className="text-sm font-medium tabular-nums">
                {ledgerUserPhone ? maskPhoneLast4(ledgerUserPhone) : "—"}
              </p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5" htmlFor="ledger-amount">
                {s.incoming_ledger_amount_label}
              </label>
              <input
                id="ledger-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={ledgerAmount}
                onChange={(e) => setLedgerAmount(e.target.value)}
                placeholder={s.incoming_ledger_amount_placeholder}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">{s.incoming_ledger_service_label}</p>
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-2.5">
                <p
                  className={cn(
                    "text-sm leading-snug whitespace-pre-wrap break-words",
                    ledgerOrderNote.trim()
                      ? "text-foreground"
                      : "text-muted-foreground italic",
                  )}
                >
                  {ledgerOrderNote.trim() || s.incoming_ledger_no_description}
                </p>
              </div>
            </div>
            <div>
              <label
                className="text-xs text-muted-foreground block mb-1.5"
                htmlFor="ledger-vendor-note"
              >
                {s.incoming_ledger_vendor_note_label}
              </label>
              <textarea
                id="ledger-vendor-note"
                value={ledgerVendorNote}
                onChange={(e) => setLedgerVendorNote(e.target.value.slice(0, 100))}
                maxLength={100}
                rows={2}
                placeholder={s.incoming_ledger_vendor_note_placeholder}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="button"
              data-testid="ledger-submit-btn"
              disabled={ledgerSubmitting || !ledgerAmount.trim()}
              onClick={() => void confirmLedgerEntry()}
              className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
            >
              {ledgerSubmitting ? s.incoming_saving : s.khata_addToLedgerSubmit}
            </button>
          </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={declineOrderId != null} onOpenChange={(open) => !open && closeDeclineSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>{s.incoming_decline_booking_title}</SheetTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {s.incoming_decline_reason_hint}
            </p>
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
            data-testid="incoming-decline-btn"
            disabled={
              declining ||
              !selectedReason ||
              (selectedReason === "Other" && !otherReasonText.trim())
            }
            onClick={() => void confirmDeclineBooking()}
            className="mt-4 w-full rounded-xl bg-destructive text-destructive-foreground py-3 font-semibold disabled:opacity-50"
          >
            {declining ? s.incoming_saving : s.incoming_confirm_decline}
          </button>
        </SheetContent>
      </Sheet>

      {editBillTarget && (
        <BillEditSheet
          isOpen={editBillTarget !== null}
          onClose={() => setEditBillTarget(null)}
          billId={editBillTarget.billId}
          requestId={editBillTarget.requestId}
          vendorId={vendorId}
          userPhone={editBillTarget.userPhone}
          shopName={brandForOrder(
            rows.find((r) => r.id === editBillTarget.requestId)?.category_id,
          )}
          originalTotal={editBillTarget.total_amount}
          paymentMode={editBillTarget.payment_mode}
          paymentStatus={editBillTarget.payment_status}
          onSuccess={(result: VendorEditBillResult) => {
            const updated = result.bill;
            setBillsByRequestId((prev) => ({
              ...prev,
              [editBillTarget.requestId]: {
                id: updated.id,
                total_amount: Number(updated.total_amount),
                payment_mode: updated.payment_mode as OrderBillSummary["payment_mode"],
                payment_status: updated.payment_status,
              },
            }));
            setEditedBillIds((prev) => new Set(prev).add(updated.id));
            setEditBillTarget(null);
          }}
        />
      )}

      <BillEditHistorySheet
        billId={historyBillId}
        isOpen={historyBillId !== null}
        onClose={() => setHistoryBillId(null)}
        vendorId={vendorId}
        vendorPhone={getUserPhone()?.trim() ?? ""}
      />

      {billRequestId && (
        <BillSheet
          isOpen={billRequestId !== null}
          onClose={() => {
            setBillRequestId(null);
            setBillUserPhone(null);
            void loadBillsForOrders(rows.map((row) => row.id));
          }}
          requestId={billRequestId}
          vendorId={vendorId}
          userPhone={billUserPhone}
          shopName={brandForOrder(rows.find((r) => r.id === billRequestId)?.category_id)}
          khataAmberLimit={khataAmberLimit}
          khataRedLimit={khataRedLimit}
        />
      )}

      {callBridgeVendor && (
        <AiBridgeSheet
          open={callSheetOpen}
          onClose={() => setCallSheetOpen(false)}
          vendor={callBridgeVendor}
          callerPhone={getUserPhone() ?? ""}
        />
      )}
      </div>
    </div>
  );
}
