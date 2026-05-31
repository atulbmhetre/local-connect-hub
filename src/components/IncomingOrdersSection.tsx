import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, invokecalculateTrustScore, fetchUserTrust, invokeNotifyUser } from "@/lib/supabase";
import { saveNotification } from "@/lib/notifications";
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
import { BillSheet } from "@/components/BillSheet";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const FLAG_OPTIONS = [
  { value: "noshow" as const, label: "User was not available / no-show" },
  { value: "fake" as const, label: "Request seemed fake or a prank" },
  { value: "abusive" as const, label: "User was rude or abusive" },
];

type TrustInfo = {
  trust_score: number;
  total_orders: number;
  is_banned: boolean;
  ban_reason: string | null;
} | null;

function getUserTrustBadge(trust: TrustInfo | undefined): { label: string; className: string } | null {
  if (trust === undefined) return null;
  if (trust === null || trust.total_orders < 3) {
    return { label: "🔵 New User", className: "text-blue-500/80" };
  }
  if (trust.trust_score >= 75) {
    return { label: "🟢 Trusted User", className: "text-green-600 dark:text-green-500" };
  }
  if (trust.trust_score >= 50) {
    return { label: "🟡 Has Complaints", className: "text-amber-600 dark:text-amber-500" };
  }
  return { label: "🔴 Risky User", className: "text-red-600 dark:text-red-500" };
}

function OrderTrustLoader({
  orderId,
  userPhone,
  onLoaded,
}: {
  orderId: string;
  userPhone: string;
  onLoaded: (orderId: string, trust: TrustInfo) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    void fetchUserTrust(userPhone).then((data) => {
      if (!cancelled) onLoaded(orderId, data);
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, userPhone, onLoaded]);
  return null;
}

type Props = {
  vendorId: string;
  serviceMode?: "help" | "delivery" | "appointment" | null;
  onUnreadCount?: (n: number) => void;
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

export function IncomingOrdersSection({ vendorId, serviceMode, onUnreadCount }: Props) {
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
  const [rows, setRows] = useState<OrderRequestRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [calledUser, setCalledUser] = useState<Record<string, boolean>>({});
  const [presetReasons, setPresetReasons] = useState<string[]>([]);
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [declineOrderId, setDeclineOrderId] = useState<string | null>(null);
  const [declineUserPhone, setDeclineUserPhone] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [otherReasonText, setOtherReasonText] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [billRequestId, setBillRequestId] = useState<string | null>(null);
  const [billUserPhone, setBillUserPhone] = useState<string | null>(null);
  const [flagOrderId, setFlagOrderId] = useState<string | null>(null);
  const [flagUserPhone, setFlagUserPhone] = useState<string | null>(null);
  const [selectedFlagType, setSelectedFlagType] = useState<
    "noshow" | "fake" | "abusive" | null
  >(null);
  const [flagNotes, setFlagNotes] = useState("");
  const [flagSubmitting, setFlagSubmitting] = useState(false);
  const [flaggedOrderIds, setFlaggedOrderIds] = useState<Record<string, boolean>>({});
  const [trustMap, setTrustMap] = useState<Record<string, TrustInfo>>({});
  const [vendor, setVendor] = useState<{ id: string; shop_name: string } | null>(null);
  const [requestIdsWithLedger, setRequestIdsWithLedger] = useState<Set<string>>(() => new Set());
  const [requestIdsDismissBlockedByKhata, setRequestIdsDismissBlockedByKhata] = useState<
    Set<string>
  >(() => new Set());
  const [ledgerOrderId, setLedgerOrderId] = useState<string | null>(null);
  const [ledgerUserPhone, setLedgerUserPhone] = useState<string | null>(null);
  const [ledgerAmount, setLedgerAmount] = useState("");
  const [ledgerOrderNote, setLedgerOrderNote] = useState("");
  const [ledgerVendorNote, setLedgerVendorNote] = useState("");
  const [ledgerSubmitting, setLedgerSubmitting] = useState(false);
  const mounted = useRef(true);

  const handleTrustLoaded = useCallback((orderId: string, trust: TrustInfo) => {
    setTrustMap((prev) => ({ ...prev, [orderId]: trust }));
  }, []);

  const selectFields =
    "id, device_id, vendor_id, message, status, created_at, user_phone, delivery_address, delivery_slot, appointment_time, appointment_status, cancel_reason";

  const FULFILLED_STALE_MS = 60 * 60 * 1000;

  const refreshUnpaidKhataDismissBlocks = useCallback(
    async (terminalIds: string[]) => {
      if (terminalIds.length === 0) {
        setRequestIdsDismissBlockedByKhata(new Set());
        return;
      }

      const { data: khataTxs } = await supabase
        .from("khata_transactions")
        .select("request_id, user_phone")
        .eq("vendor_id", vendorId)
        .eq("payment_mode", "khata")
        .in("request_id", terminalIds);

      if (!khataTxs?.length) {
        setRequestIdsDismissBlockedByKhata(new Set());
        return;
      }

      const phones = [
        ...new Set(
          khataTxs
            .map((t) => t.user_phone)
            .filter((p): p is string => typeof p === "string" && p.length > 0),
        ),
      ];

      if (phones.length === 0) {
        setRequestIdsDismissBlockedByKhata(new Set());
        return;
      }

      const { data: ledgerRows } = await supabase
        .from("khata_ledger")
        .select("user_phone, total_outstanding")
        .eq("vendor_id", vendorId)
        .in("user_phone", phones);

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
    [vendorId],
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
      const { error } = await supabase
        .from("requests")
        .update({ status: "done" })
        .eq("vendor_id", vendorId)
        .in("id", toDismissIds);

      if (error) return orderList;

      const dismissSet = new Set(toDismissIds);
      return orderList.filter((r) => !dismissSet.has(r.id));
    },
    [vendorId],
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
      const list = (data ?? []) as OrderRequestRow[];

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
      await refreshUnpaidKhataDismissBlocks(terminalIds);

      let activeList = await autoDismissStaleFulfilledOnLoad(list, withLedger);
      setRows(activeList);
      onUnreadCount?.(activeList.filter((r) => r.status === "sent").length);

      if (!opts?.silent) setLoading(false);

      const hadSent = !isHelpMode && activeList.some((r) => r.status === "sent");
      if (hadSent) {
        const { error: upErr } = await supabase
          .from("requests")
          .update({ status: "seen" })
          .eq("vendor_id", vendorId)
          .eq("status", "sent");
        if (upErr || !mounted.current) return;
        const { data: refreshed } = await supabase
          .from("requests")
          .select(selectFields)
          .eq("vendor_id", vendorId)
          .or(windowOr)
          .order("created_at", { ascending: false })
          .limit(20);
        if (!mounted.current) return;
        const refreshedList = ((refreshed ?? []) as OrderRequestRow[]) ?? activeList;
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
        await refreshUnpaidKhataDismissBlocks(refreshedTerminalIds);
        activeList = await autoDismissStaleFulfilledOnLoad(refreshedList, withLedger);
        setRows(activeList);
        onUnreadCount?.(activeList.filter((r) => r.status === "sent").length);
      }
    },
    [vendorId, onUnreadCount, isHelpMode, autoDismissStaleFulfilledOnLoad, refreshUnpaidKhataDismissBlocks],
  );

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("vendors")
        .select(
          "id, shop_name, cancel_reason_1, cancel_reason_2, cancel_reason_3, cancel_reason_4",
        )
        .eq("id", vendorId)
        .single();
      if (!data) return;
      setVendor({ id: data.id, shop_name: data.shop_name });
      const presets = [
        data.cancel_reason_1,
        data.cancel_reason_2,
        data.cancel_reason_3,
        data.cancel_reason_4,
      ].filter((r): r is string => r != null && String(r).trim() !== "");
      setPresetReasons(presets);
    })();
  }, [vendorId]);

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
    setMarkingId(id);
    const { data, error } = await supabase
      .from("requests")
      .update({ status: "accepted" })
      .eq("id", id)
      .eq("status", "sent")
      .select("id");
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
      return;
    }
    if (!data?.length) {
      toast.error(s.order_already_taken);
      setRows((prev) => prev.filter((r) => r.id !== id));
      return;
    }
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, status: "accepted" } : r));
      onUnreadCount?.(next.filter((r) => r.status === "sent").length);
      return next;
    });
  };

  const acceptDeliveryOrder = async (id: string, userPhone: string | null) => {
    setMarkingId(id);
    const { data, error } = await supabase
      .from("requests")
      .update({ status: "accepted" })
      .eq("id", id)
      .eq("status", "seen")
      .select("id");
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
      return;
    }
    if (!data?.length) {
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
      });
      saveNotification({
        userPhone: phone,
        type: "order_update",
        title: s.incoming_orderAcceptedTitle,
        body: s.incoming_orderAcceptedBody,
        route: "my-orders",
        isInformational: false,
      });
    }
    void load({ silent: true });
  };

  const markDone = async (id: string) => {
    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ status: "fulfilled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
      return;
    }
    if (userPhone) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.incoming_orderFulfilledNotifyTitle,
        body: s.incoming_orderFulfilledNotifyBody,
      });
      saveNotification({
        userPhone,
        type: "order_update",
        title: s.incoming_orderFulfilledNotifyTitle,
        body: s.incoming_orderFulfilledNotifyBody,
        route: "my-orders",
        isInformational: false,
      });
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "fulfilled" } : r)));
  };

  const dismissOrder = async (id: string) => {
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ status: "done" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
    if (error) {
      toast.error(s.incoming_errCouldNotUpdate, { description: error.message });
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleAppointmentAction = async (id: string, action: "confirmed" | "declined") => {
    if (action === "declined") return;
    const userPhone = rows.find((r) => r.id === id)?.user_phone?.trim() || "";
    setMarkingId(id);
    const { error } = await supabase
      .from("requests")
      .update({ appointment_status: action })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    setMarkingId(null);
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
      });
      saveNotification({
        userPhone,
        type: "order_update",
        title: s.incoming_bookingConfirmedNotifyTitle,
        body: s.incoming_bookingConfirmedNotifyBody,
        route: "my-orders",
        isInformational: false,
      });
    }
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, appointment_status: action } : r)),
    );
    toast.success(s.incoming_apptConfirmed);
  };

  const closeDeclineSheet = () => {
    setDeclineOrderId(null);
    setDeclineUserPhone(null);
    setSelectedReason(null);
    setOtherReasonText("");
  };

  const confirmDeclineBooking = async () => {
    if (!declineOrderId || !selectedReason) return;
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const userPhone =
      declineUserPhone?.trim() ||
      rows.find((r) => r.id === declineOrderId)?.user_phone?.trim() ||
      "";

    setDeclining(true);
    setMarkingId(declineOrderId);
    const { error } = await supabase
      .from("requests")
      .update({
        appointment_status: "declined",
        status: "seen",
        cancel_reason: reasonText,
      })
      .eq("id", declineOrderId)
      .eq("vendor_id", vendorId);
    setDeclining(false);
    setMarkingId(null);
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
      });
      saveNotification({
        userPhone,
        type: "order_update",
        title,
        body,
        route: "my-orders",
        isInformational: false,
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
      const vendorPart = ledgerVendorNote.trim();
      const combinedNote = ledgerOrderNote
        ? `${ledgerOrderNote}${vendorPart ? ` — ${vendorPart}` : ""}`
        : vendorPart || null;

      const { error } = await supabase.from("khata_transactions").insert({
        vendor_id: vendorId,
        user_phone: ledgerUserPhone,
        amount,
        note: combinedNote,
        payment_mode: "khata",
        request_id: ledgerOrderId,
        created_at: new Date().toISOString(),
      });

      if (error) {
        toast.error(error.message);
        return;
      }

      const { data: existing } = await supabase
        .from("khata_ledger")
        .select("total_outstanding")
        .eq("vendor_id", vendorId)
        .eq("user_phone", ledgerUserPhone)
        .single();

      const currentOutstanding = existing?.total_outstanding ?? 0;

      await supabase.from("khata_ledger").upsert(
        {
          vendor_id: vendorId,
          user_phone: ledgerUserPhone,
          total_outstanding: currentOutstanding + amount,
          last_updated: new Date().toISOString(),
        },
        { onConflict: "vendor_id,user_phone" },
      );

      const terminalIds = rows
        .filter((r) => r.status === "fulfilled" || r.status === "done")
        .map((r) => r.id);
      await refreshUnpaidKhataDismissBlocks(terminalIds);

      setRequestIdsWithLedger((prev) => new Set(prev).add(ledgerOrderId));
      closeLedgerSheet();
      toast.success("Ledger entry added");
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
    const { error } = await supabase.from("user_flags").insert({
      request_id: flagOrderId,
      vendor_id: vendorId,
      user_phone: flagUserPhone,
      flag_type: selectedFlagType,
      notes: flagNotes.trim() || null,
    });
    setFlagSubmitting(false);

    if (error) {
      console.error("submitFlagReport", error);
      return;
    }

    void invokecalculateTrustScore(flagUserPhone);
    setFlaggedOrderIds((prev) => ({ ...prev, [flagOrderId]: true }));
    closeFlagSheet();
    toast.success("Report submitted — thank you for keeping the community safe");
  };

  const confirmCancelOrder = async () => {
    if (!cancelOrderId || !selectedReason) return;
    const reasonText =
      selectedReason === "Other" ? otherReasonText.trim() : selectedReason;
    if (!reasonText) return;

    const order = rows.find((r) => r.id === cancelOrderId);
    const isAppointmentOrder =
      order?.appointment_status === "confirmed" || !!order?.appointment_time;
    const updatePayload: {
      status: "cancelled";
      cancel_reason: string;
      appointment_status?: "cancelled";
    } = { status: "cancelled", cancel_reason: reasonText };
    if (isAppointmentOrder) {
      updatePayload.appointment_status = "cancelled";
    }

    setCancelling(true);
    const { error } = await supabase
      .from("requests")
      .update(updatePayload)
      .eq("id", cancelOrderId)
      .eq("vendor_id", vendorId);
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
      });
      saveNotification({
        userPhone,
        type: "order_update",
        title,
        body,
        route: "my-orders",
        isInformational: false,
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

  const cancelAppointment = async (id: string) => {
    const { error } = await supabase
      .from("requests")
      .update({ appointment_status: "cancelled" })
      .eq("id", id)
      .eq("vendor_id", vendorId);
    if (error) {
      toast.error(s.incoming_errCouldNotCancel, { description: error.message });
      return;
    }
    toast.success(s.incoming_bookingCancelled);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, appointment_status: "cancelled" } : r)),
    );
  };

  const unread = rows.filter((r) => r.status === "sent").length;

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

  const badge = (status: string) => {
    if (status === "sent")
      return (
        <span className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-bold px-2 py-0.5 border border-brand/40">
          {s.incoming_statusNew}
        </span>
      );
    if (status === "seen")
      return (
        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
          {s.incoming_statusSeen}
        </span>
      );
    if (status === "accepted")
      return (
        <span className="rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-semibold px-2 py-0.5 border border-brand/40">
          {s.status_accepted}
        </span>
      );
    if (status === "fulfilled")
      return (
        <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand">
          {s.incoming_statusDone}
        </span>
      );
    if (status === "cancelled")
      return (
        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
          {s.orderCancelled}
        </span>
      );
    return (
      <span className="rounded-full text-[10px] font-semibold px-2 py-0.5 border border-brand-border text-brand">
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
              className="rounded-xl border border-border bg-muted/30 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatTimeAgo(r.created_at)}
                </span>
                {shouldShowStatusBadge(r) && badge(r.status)}
              </div>
              <p className="text-sm text-foreground leading-snug whitespace-pre-wrap break-words">
                {stripLocationTag(r.message)}
              </p>
              {r.user_phone && (
                <>
                  <OrderTrustLoader
                    orderId={r.id}
                    userPhone={r.user_phone}
                    onLoaded={handleTrustLoaded}
                  />
                  {(() => {
                    const trustBadge = getUserTrustBadge(trustMap[r.id]);
                    if (!trustBadge) return null;
                    return (
                      <p className={cn("text-xs font-normal", trustBadge.className)}>
                        {trustBadge.label}
                      </p>
                    );
                  })()}
                </>
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
                    disabled={markingId === r.id}
                    onClick={() => void handleAppointmentAction(r.id, "confirmed")}
                    className="rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {s.incoming_btnConfirm}
                  </button>
                  <button
                    type="button"
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
                    <span className="inline-flex rounded-full bg-brand/20 text-green-700 dark:text-brand text-[10px] font-semibold px-2 py-0.5 border border-brand/40">
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
                        <button
                          type="button"
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

              {!r.appointment_time && isHelpMode && r.status === "sent" && (
                  <button
                    type="button"
                    disabled={markingId === r.id}
                    onClick={() => void acceptHelpOrder(r.id)}
                    className="w-full rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                  >
                    {markingId === r.id ? s.incoming_saving : s.incoming_btnAccept}
                  </button>
                )}

              {!r.appointment_time && !isHelpMode && r.status === "seen" && (
                <button
                  type="button"
                  disabled={markingId === r.id}
                  onClick={() => void acceptDeliveryOrder(r.id, r.user_phone ?? null)}
                  className="w-full rounded-lg bg-primary text-primary-foreground text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
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
                  {(r.status === "accepted" || r.status === "fulfilled") && (
                    <button
                      type="button"
                      onClick={() => {
                        setBillRequestId(r.id);
                        setBillUserPhone(r.user_phone);
                      }}
                      className="w-full rounded-xl border border-primary/50 text-primary text-sm font-semibold py-2.5 active:scale-[0.99]"
                    >
                      {s.bill_title}
                    </button>
                  )}
                  {r.status === "accepted" && (
                    <button
                      type="button"
                      disabled={markingId === r.id}
                      onClick={() => void markDone(r.id)}
                      className="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-semibold py-2 active:scale-[0.99] disabled:opacity-50"
                    >
                      {markingId === r.id ? s.incoming_saving : s.incoming_markDone}
                    </button>
                  )}
                  {(r.status === "fulfilled" || r.status === "cancelled") &&
                    r.user_phone &&
                    !flaggedOrderIds[r.id] && (
                      <button
                        type="button"
                        onClick={() => openFlagSheet(r)}
                        className="w-full text-left text-[11px] text-muted-foreground/80 hover:text-muted-foreground py-1"
                      >
                        🚩 Report an issue with this order
                      </button>
                    )}
                </>
              )}

              {(r.status === "fulfilled" || r.status === "done") && (
                <div className="space-y-2">
                  {canAddToLedger && r.user_phone && !requestIdsWithLedger.has(r.id) && (
                    <button
                      type="button"
                      onClick={() => openLedgerSheet(r)}
                      className="w-full rounded-lg border border-primary/50 text-primary text-xs font-semibold py-2 active:scale-[0.99]"
                    >
                      📒 Add to Ledger
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
                          {markingId === r.id ? s.incoming_saving : "✅ Dismiss"}
                        </button>
                        {dismissBlockedByKhata && (
                          <p className="text-[10px] text-muted-foreground text-center mt-1">
                            Settle ledger dues first
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Sheet open={flagOrderId != null} onOpenChange={(open) => !open && closeFlagSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>Report an Issue</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <RadioGroup
              value={selectedFlagType ?? ""}
              onValueChange={(value) =>
                setSelectedFlagType(value as "noshow" | "fake" | "abusive")
              }
            >
              {FLAG_OPTIONS.map((opt) => (
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
                Additional notes (optional)
              </label>
              <textarea
                id="flag-notes"
                value={flagNotes}
                onChange={(e) => setFlagNotes(e.target.value.slice(0, 200))}
                maxLength={200}
                rows={2}
                placeholder="Additional notes (optional)"
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="button"
              disabled={flagSubmitting || !selectedFlagType}
              onClick={() => void submitFlagReport()}
              className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
            >
              {flagSubmitting ? s.incoming_saving : "Submit Report"}
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
            <SheetTitle>Add to Ledger</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">Customer phone</label>
              <p className="text-sm font-medium tabular-nums">
                {ledgerUserPhone ? maskPhoneLast4(ledgerUserPhone) : "—"}
              </p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5" htmlFor="ledger-amount">
                Amount
              </label>
              <input
                id="ledger-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={ledgerAmount}
                onChange={(e) => setLedgerAmount(e.target.value)}
                placeholder="Amount charged ₹"
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Service</p>
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-2.5">
                <p
                  className={cn(
                    "text-sm leading-snug whitespace-pre-wrap break-words",
                    ledgerOrderNote.trim()
                      ? "text-foreground"
                      : "text-muted-foreground italic",
                  )}
                >
                  {ledgerOrderNote.trim() || "No description"}
                </p>
              </div>
            </div>
            <div>
              <label
                className="text-xs text-muted-foreground block mb-1.5"
                htmlFor="ledger-vendor-note"
              >
                Additional note (optional)
              </label>
              <textarea
                id="ledger-vendor-note"
                value={ledgerVendorNote}
                onChange={(e) => setLedgerVendorNote(e.target.value.slice(0, 100))}
                maxLength={100}
                rows={2}
                placeholder="Add a note..."
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="button"
              disabled={ledgerSubmitting || !ledgerAmount.trim()}
              onClick={() => void confirmLedgerEntry()}
              className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold disabled:opacity-50"
            >
              {ledgerSubmitting ? s.incoming_saving : "Add to Ledger (Unpaid)"}
            </button>
          </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={declineOrderId != null} onOpenChange={(open) => !open && closeDeclineSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>Decline Booking</SheetTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Select a reason (shown to customer)
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
            disabled={
              declining ||
              !selectedReason ||
              (selectedReason === "Other" && !otherReasonText.trim())
            }
            onClick={() => void confirmDeclineBooking()}
            className="mt-4 w-full rounded-xl bg-destructive text-destructive-foreground py-3 font-semibold disabled:opacity-50"
          >
            {declining ? s.incoming_saving : "Confirm Decline"}
          </button>
        </SheetContent>
      </Sheet>

      {billRequestId && vendor && (
        <BillSheet
          isOpen={billRequestId !== null}
          onClose={() => {
            setBillRequestId(null);
            setBillUserPhone(null);
          }}
          requestId={billRequestId}
          vendorId={vendor.id}
          userPhone={billUserPhone}
          shopName={vendor.shop_name}
        />
      )}
      </div>
    </div>
  );
}
