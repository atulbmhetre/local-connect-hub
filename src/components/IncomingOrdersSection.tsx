import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase, invokecalculateTrustScore, invokeNotifyUser } from "@/lib/supabase";
import { formatTimeAgo, buildRequestsActiveWindowOrFilter, type OrderRequestRow } from "@/lib/orders";
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
};

type EditBillTarget = {
  billId: string;
  requestId: string;
  userPhone: string | null;
  total_amount: number;
  payment_mode: OrderBillSummary["payment_mode"];
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

type Props = {
  vendorId: string;
  serviceMode?: "help" | "delivery" | "appointment" | null;
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

function countUnreadIncomingOrders(
  orderList: Pick<OrderRequestRow, "status">[],
  serviceMode: "help" | "delivery" | "appointment" | null | undefined,
): number {
  if (serviceMode === "delivery" || serviceMode === "appointment") {
    return orderList.filter((r) => r.status === "sent" || r.status === "seen").length;
  }
  return orderList.filter((r) => r.status === "sent").length;
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
  const { s } = useLanguage();
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
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [calledUser, setCalledUser] = useState<Record<string, boolean>>({});
  const [callSheetOpen, setCallSheetOpen] = useState(false);
  const [callTargetPhone, setCallTargetPhone] = useState<string | null>(null);
  const [callServiceMode, setCallServiceMode] = useState<string>("help");
  const presetReasons = useMemo(
    () => cancelReasons.filter((r): r is string => r != null && String(r).trim() !== ""),
    [cancelReasons],
  );
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [declineOrderId, setDeclineOrderId] = useState<string | null>(null);
  const [declineUserPhone, setDeclineUserPhone] = useState<string | null>(null);
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
    const { data, error } = await supabase
      .from("users")
      .select("phone, trust_score, total_orders, is_banned, ban_reason")
      .in("phone", phones);
    if (error) {
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
  }, []);

  const clearOrderEditedFlag = useCallback(async (orderId: string) => {
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) return;
    const { error } = await supabase.rpc("vendor_clear_order_edited", {
      p_request_id: orderId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });
    if (error) {
      console.error("clearOrderEditedFlag", error);
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === orderId ? { ...r, is_edited: false } : r)),
    );
  }, [vendorId]);

  const selectFields =
    "id, device_id, vendor_id, message, status, created_at, user_phone, delivery_address, delivery_slot, appointment_time, appointment_status, cancel_reason, is_edited, payment_status, payment_utr, customer_latitude, customer_longitude";

  const FULFILLED_STALE_MS = 60 * 60 * 1000;

  const loadBillsForOrders = useCallback(async (requestIds: string[]) => {
    if (requestIds.length === 0) {
      setBillsByRequestId({});
      setEditedBillIds(new Set());
      return;
    }
    const { data } = await supabase
      .from("order_bills")
      .select("id, request_id, total_amount, payment_mode, payment_status")
      .in("request_id", requestIds)
      .neq("payment_status", "void");

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
        };
      }
    }
    setBillsByRequestId(billMap);
    const edited = await fetchEditedBillIds(Object.values(billMap).map((b) => b.id));
    setEditedBillIds(edited);
  }, []);

  const fetchKhataOutstanding = useCallback(
    async (userPhone: string): Promise<number> => {
      const phone = userPhone.trim();
      if (!phone) return 0;
      const { data, error } = await supabase
        .from("khata_ledger")
        .select("total_outstanding")
        .eq("vendor_id", vendorId)
        .eq("user_phone", phone)
        .maybeSingle();
      if (error) return 0;
      return Number(data?.total_outstanding) || 0;
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

      let khataTxs: { request_id: string | null; user_phone: string | null }[] = [];
      if (terminalIds.length > 0) {
        const { data } = await supabase
          .from("khata_transactions")
          .select("request_id, user_phone")
          .eq("vendor_id", vendorId)
          .eq("payment_mode", "khata")
          .in("request_id", terminalIds);
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

      const { data: ledgerRows } = await supabase
        .from("khata_ledger")
        .select("user_phone, total_outstanding")
        .eq("vendor_id", vendorId)
        .in("user_phone", phones);

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
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      const windowOr = `${buildRequestsActiveWindowOrFilter("vendor")},status.eq.fulfilled`;
      const { data, error } = await supabase
        .from("requests")
        .select(selectFields)
        .eq("vendor_id", vendorId)
        .or(windowOr)
        .order("created_at", { ascending: false })
        .limit(20);
      if (!mounted.current) return;
      if (error) {
        setRows([]);
        onUnreadCount?.(0);
        setLoading(false);
        return;
      }
      const list = (data ?? []) as IncomingOrderRow[];

      const terminalIds = list
        .filter((r) => r.status === "fulfilled" || r.status === "done")
        .map((r) => r.id);
      let withLedger = new Set<string>();
      if (terminalIds.length > 0) {
        const { data: ledgerRows } = await supabase
          .from("khata_transactions")
          .select("request_id")
          .eq("vendor_id", vendorId)
          .in("request_id", terminalIds);
        withLedger = new Set(
          (ledgerRows ?? [])
            .map((row) => row.request_id)
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
        const vendorPhone = getUserPhone()?.trim();
        if (vendorPhone) {
          const { error: upErr } = await supabase.rpc("vendor_mark_sent_seen", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhone,
          });
          if (upErr || !mounted.current) return;
        } else if (!mounted.current) {
          return;
        }
        const { data: refreshed } = await supabase
          .from("requests")
          .select(selectFields)
          .eq("vendor_id", vendorId)
          .or(windowOr)
          .order("created_at", { ascending: false })
          .limit(20);
        if (!mounted.current) return;
        const refreshedList = ((refreshed ?? []) as IncomingOrderRow[]) ?? activeList;
        const refreshedTerminalIds = refreshedList
          .filter((r) => r.status === "fulfilled" || r.status === "done")
          .map((r) => r.id);
        if (refreshedTerminalIds.length > 0) {
          const { data: ledgerRows } = await supabase
            .from("khata_transactions")
            .select("request_id")
            .eq("vendor_id", vendorId)
            .in("request_id", refreshedTerminalIds);
          withLedger = new Set(
            (ledgerRows ?? [])
              .map((row) => row.request_id)
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
      autoDismissStaleFulfilledOnLoad,
      refreshUnpaidKhataDismissBlocks,
      loadBillsForOrders,
      loadTrustForOrders,
    ],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    const t = window.setInterval(() => void load({ silent: true }), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(t);
    };
  }, [load]);

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
          void load({ silent: true });
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
          void load({ silent: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [vendorId, load]);

  const acceptHelpOrder = async (id: string) => {
    void clearOrderEditedFlag(id);
    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    setMarkingId(id);
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
        void invokeNotifyUser({
          user_phone: userPhone,
          title: s.incoming_helpAcceptedNotifyTitle,
          body: s.incoming_helpAcceptedNotifyBody,
          type: "order_accepted",
          order_id: id,
        });
      }
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
      setMarkingId(null);
    }
  };

  const acceptDeliveryOrder = async (id: string, userPhone: string | null) => {
    void clearOrderEditedFlag(id);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    setMarkingId(id);
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
      const phone = userPhone?.trim();
      if (phone) {
        void invokeNotifyUser({
          user_phone: phone,
          title: s.incoming_orderAcceptedTitle,
          body: s.incoming_orderAcceptedBody,
          type: "order_update",
          order_id: id,
        });
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
      setMarkingId(null);
    }
  };

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
        type: "payment_confirmed",
        order_id: requestId,
      });
    }
  };

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
    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdateAppt);
      return;
    }
    setMarkingId(id);
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
        console.error("handleAppointmentAction", action, error);
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
      setMarkingId(null);
    }
  };

  const closeDeclineSheet = () => {
    setDeclineOrderId(null);
    setDeclineUserPhone(null);
    setSelectedReason(null);
    setOtherReasonText("");
  };

  const handleCallCustomer = (phone: string, mode: string) => {
    setCallTargetPhone(phone);
    setCallServiceMode(mode);
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
    void clearOrderEditedFlag(declineOrderId);
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const userPhone =
      declineUserPhone?.trim() ||
      rows.find((r) => r.id === declineOrderId)?.user_phone?.trim() ||
      "";

    setDeclining(true);
    setMarkingId(declineOrderId);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setDeclining(false);
      setMarkingId(null);
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
        console.error("confirmDeclineBooking", error);
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
      setDeclining(false);
      setMarkingId(null);
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

    try {
      setLedgerSubmitting(true);
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
        toast.error(error?.message ?? s.bill_sendFailed);
        return;
      }

      const title = s.bill_notifTitle;
      const body = `${shopName}: ₹${amount} — khata`;
      void invokeNotifyUser({
        user_phone: ledgerUserPhone,
        title,
        body,
        type: "bill",
        order_id: ledgerOrderId,
      });

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
      setLedgerSubmitting(false);
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
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const order = rows.find((r) => r.id === cancelOrderId);
    const isAppointmentOrder =
      order?.appointment_status === "confirmed" || !!order?.appointment_time;

    setCancelling(true);
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setCancelling(false);
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    const { error } = await supabase.rpc("vendor_cancel_order", {
      p_request_id: cancelOrderId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_cancel_reason: reasonText,
      p_cancel_appointment: isAppointmentOrder,
    });
    setCancelling(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const userPhone = rows.find((r) => r.id === cancelOrderId)?.user_phone?.trim();
    if (userPhone) {
      const title = s.incoming_orderCancelledNotifyTitle;
      const body = s.incoming_orderCancelledNotifyBody(reasonText);
      void invokeNotifyUser({
        user_phone: userPhone,
        title,
        body,
        type: "order_update",
        order_id: declineOrderId,
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
  };

  const unread = countUnreadIncomingOrders(rows, serviceMode);

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
    <div className="mx-4 rounded-2xl border border-surface-border bg-surface overflow-hidden">
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

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">{s.incoming_empty}</p>
      ) : searchQuery.trim() && filteredRows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {s.search_noResults}
        </div>
      ) : (
        <ul className="space-y-3">
          {filteredRows.map((r) => (
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
                const mapsUrl = resolveVendorNavigateToCustomerUrl(serviceMode, r);
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
                          {new Date(r.appointment_time).toLocaleString("en-IN", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
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
                        {r.user_phone && (
                          <button
                            type="button"
                            onClick={() =>
                              handleCallCustomer(r.user_phone!, serviceMode ?? "appointment")
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

              {!r.appointment_time && isHelpMode && r.status === "sent" && (
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

              {!r.appointment_time && !isHelpMode && r.status === "seen" && (
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
                      {r.user_phone && (
                        <button
                          type="button"
                          onClick={() =>
                            handleCallCustomer(r.user_phone!, serviceMode ?? "help")
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
                  {canAddToLedger &&
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
          ))}
        </ul>
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
          shopName={shopName}
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
          shopName={shopName}
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
