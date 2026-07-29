import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase, invokeNotifyUser, invokeInitiateCall } from "@/lib/supabase";
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import {
  currentCycleTransactions,
  filterKhataLedgerByOutstanding,
  formatKhataBalanceDisplay,
  formatKhataDate,
  formatLedgerCycleStartLabel,
  khataPaymentModeLabel,
  ledgerCycleStartIso,
  mapKhataRefundError,
  maskPhoneLast4,
} from "@/lib/khataDisplay";

const STORAGE_KEY = "aaspaas:vendor_id";

type LedgerEntry = {
  user_phone: string;
  total_outstanding: number;
  last_updated: string;
};

function CustomerIdentity({
  phone,
  customerNameByPhone,
  listLayout = false,
}: {
  phone: string;
  customerNameByPhone: Map<string, string>;
  listLayout?: boolean;
}) {
  const name = customerNameByPhone.get(phone)?.trim();
  if (name) {
    return (
      <div className={listLayout ? "min-w-0" : undefined}>
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        <p className="text-sm text-muted-foreground tabular-nums">{maskPhoneLast4(phone)}</p>
      </div>
    );
  }
  return (
    <span
      className={cn(
        "tabular-nums",
        listLayout ? "text-sm font-bold text-foreground" : "text-base font-bold text-foreground",
      )}
    >
      {maskPhoneLast4(phone)}
    </span>
  );
}

type KhataTransaction = {
  id: string;
  amount: number;
  note: string | null;
  payment_mode: string;
  created_at: string;
};

const LedgerView = () => {
  const navigate = useNavigate();
  const { s } = useLanguage();
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [shopName, setShopName] = useState("");
  const [ledgerCycleStart, setLedgerCycleStart] = useState<string | null>(null);
  const [khataAmberLimit, setKhataAmberLimit] = useState(0);
  const [khataRedLimit, setKhataRedLimit] = useState(0);
  const [vendorPhone, setVendorPhone] = useState("");
  const [vendorServiceMode, setVendorServiceMode] = useState("help");
  const [customerNameByPhone, setCustomerNameByPhone] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [entriesNetworkStatus, setEntriesNetworkStatus] = useState<
    "retrying" | "failed" | null
  >(null);
  const loadEntriesRetryRef = useRef({ id: "", phone: "" });
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<KhataTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txNetworkStatus, setTxNetworkStatus] = useState<"retrying" | "failed" | null>(null);
  const loadTransactionsRetryRef = useRef({ id: "", userPhone: "" });
  const [callLoading, setCallLoading] = useState(false);
  const [amountSheetMode, setAmountSheetMode] = useState<"payment" | "refund" | null>(null);
  const [amountValue, setAmountValue] = useState("");
  const [savingAmount, setSavingAmount] = useState(false);
  const savingAmountLockRef = useRef(false);
  const [sheetShowFullHistory, setSheetShowFullHistory] = useState(false);
  const [hasHistoryBeyondCycle, setHasHistoryBeyondCycle] = useState(false);
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false);
  const [fullHistoryTransactions, setFullHistoryTransactions] = useState<KhataTransaction[]>([]);
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  const [fullHistoryNetworkStatus, setFullHistoryNetworkStatus] = useState<
    "retrying" | "failed" | null
  >(null);
  const loadFullHistoryRetryRef = useRef({
    id: "",
    userPhone: "",
    cycleStart: null as string | null,
  });
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  const selectedEntry = entries.find((e) => e.user_phone === selectedPhone) ?? null;
  const selectedCustomerName = selectedPhone
    ? customerNameByPhone.get(selectedPhone)?.trim() ?? ""
    : "";
  const visibleEntries = filterKhataLedgerByOutstanding(entries, false);
  const parsedAmount = parseFloat(amountValue);
  const maxAmount =
    selectedEntry && amountSheetMode === "refund"
      ? Math.abs(selectedEntry.total_outstanding)
      : selectedEntry?.total_outstanding ?? 0;
  const amountValid =
    selectedEntry != null &&
    amountSheetMode != null &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= maxAmount;

  const loadEntries = useCallback(async (id: string, vendorPhoneForNames: string) => {
    loadEntriesRetryRef.current = { id, phone: vendorPhoneForNames };
    setLoading(true);
    setEntriesNetworkStatus(null);
    try {
      const { data, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("get_vendor_khata_ledger", {
              p_vendor_id: id,
              p_vendor_phone: vendorPhoneForNames,
              p_user_phones: null,
            }),
          ),
        {
          onRetrying: () => setEntriesNetworkStatus("retrying"),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      if (error) {
        toast.error(error.message);
        setEntries([]);
        setCustomerNameByPhone(new Map());
        return;
      }

      const ledgerRows = data ?? [];
      setEntries(ledgerRows);
      setEntriesNetworkStatus(null);

      if (ledgerRows.length === 0 || !vendorPhoneForNames) {
        setCustomerNameByPhone(new Map());
        return;
      }

      const { data: nameRows, error: namesError } = await supabase.rpc(
        "get_vendor_customer_names",
        { p_vendor_phone: vendorPhoneForNames },
      );

      if (namesError) {
        captureError(namesError, { scope: "ledgerView.loadCustomerNames", vendorId: id });
        console.error("loadCustomerNames", namesError);
        setCustomerNameByPhone(new Map());
      } else {
        const nameMap = new Map<string, string>();
        for (const row of nameRows ?? []) {
          const phone = row.phone;
          const name = typeof row.name === "string" ? row.name.trim() : "";
          if (phone && name) nameMap.set(phone, name);
        }
        setCustomerNameByPhone(nameMap);
      }
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        setEntriesNetworkStatus("failed");
        setEntries([]);
        setCustomerNameByPhone(new Map());
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async (
    id: string,
    userPhone: string,
    cycleStart: string | null = null,
    phoneForRpc?: string,
  ) => {
    const vendorPhoneForRpc = (phoneForRpc ?? getUserPhone() ?? "").trim();
    loadTransactionsRetryRef.current = { id, userPhone };
    setTxLoading(true);
    setTxNetworkStatus(null);
    if (!vendorPhoneForRpc) {
      setTransactions([]);
      setTxLoading(false);
      return;
    }
    try {
      const { data, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("get_vendor_khata_transactions", {
              p_vendor_id: id,
              p_vendor_phone: vendorPhoneForRpc,
              p_user_phone: userPhone,
              p_since: null,
            }),
          ),
        {
          onRetrying: () => setTxNetworkStatus("retrying"),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      if (error) {
        toast.error(error.message);
        setTransactions([]);
        return;
      }
      const chronological = (data ?? []) as KhataTransaction[];
      const cycle = currentCycleTransactions(chronological);
      setTransactions(cycle);
      // The unfiltered response already tells us whether the full-history view
      // (rows since the configured cycle start) would show more than the
      // current settle cycle, so that fetch can stay lazy (on user request).
      const sinceMs = new Date(ledgerCycleStartIso(cycleStart)).getTime();
      const sinceCycleStartCount = chronological.filter(
        (tx) => new Date(tx.created_at).getTime() >= sinceMs,
      ).length;
      setHasHistoryBeyondCycle(sinceCycleStartCount > cycle.length);
      setTxNetworkStatus(null);
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        setTxNetworkStatus("failed");
        setTransactions([]);
      } else {
        throw err;
      }
    } finally {
      setTxLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id?.trim()) {
      navigate("/vendor", { replace: true });
      return;
    }
    setVendorId(id);
    void (async () => {
      const phoneFromStorage = (getUserPhone() ?? "").replace(/[\s\-+]/g, "").trim();
      if (!phoneFromStorage) {
        navigate("/vendor", { replace: true });
        return;
      }
      const { data: vendor, error: vendorError } = await supabase.rpc("get_vendor_own", {
        p_vendor_id: id,
        p_vendor_phone: phoneFromStorage,
      });
      if (vendorError || !vendor) {
        navigate("/vendor", { replace: true });
        return;
      }
      setShopName(vendor.shop_name ?? "");
      setLedgerCycleStart(vendor.ledger_cycle_start ?? null);
      setKhataAmberLimit(Number(vendor.khata_amber_limit) || 0);
      setKhataRedLimit(Number(vendor.khata_red_limit) || 0);
      const phone = (vendor.phone ?? phoneFromStorage).replace(/[\s\-+]/g, "").trim();
      setVendorPhone(phone);
      setVendorServiceMode(vendor.service_mode ?? "help");
      await loadEntries(id, phone);
    })();
  }, [navigate, loadEntries]);

  const loadFullHistory = useCallback(
    async (id: string, userPhone: string, cycleStart: string | null, phoneForRpc?: string) => {
      const vendorPhoneForRpc = (phoneForRpc ?? getUserPhone() ?? "").trim();
      loadFullHistoryRetryRef.current = { id, userPhone, cycleStart };
      setFullHistoryLoading(true);
      setFullHistoryNetworkStatus(null);
      const since = ledgerCycleStartIso(cycleStart);
      if (!vendorPhoneForRpc) {
        setFullHistoryTransactions([]);
        setFullHistoryLoading(false);
        return;
      }
      try {
        const { data, error } = await withNetworkRetry(
          async () =>
            throwOnSupabaseNetworkError(
              await supabase.rpc("get_vendor_khata_transactions", {
                p_vendor_id: id,
                p_vendor_phone: vendorPhoneForRpc,
                p_user_phone: userPhone,
                p_since: since,
              }),
            ),
          {
            onRetrying: () => setFullHistoryNetworkStatus("retrying"),
            shouldRetry: () => getNavigatorOnline(),
          },
        );
        if (error) {
          toast.error(error.message);
          setFullHistoryTransactions([]);
          return;
        }
        setFullHistoryTransactions((data ?? []) as KhataTransaction[]);
        setFullHistoryNetworkStatus(null);
      } catch (err) {
        if (err instanceof NetworkExhaustedError) {
          setFullHistoryNetworkStatus("failed");
          setFullHistoryTransactions([]);
        } else {
          throw err;
        }
      } finally {
        setFullHistoryLoading(false);
      }
    },
    [],
  );

  const openCustomer = (userPhone: string) => {
    setSelectedPhone(userPhone);
    setNameEditing(false);
    setNameDraft("");
    setSheetShowFullHistory(false);
    setHasHistoryBeyondCycle(false);
    setFullHistoryLoaded(false);
    setFullHistoryTransactions([]);
    if (vendorId) {
      // Full history is lazy-loaded only when the vendor taps "show full
      // history" — customer-open fetches just the current cycle data.
      void loadTransactions(vendorId, userPhone, ledgerCycleStart);
    }
  };

  const hasAdditionalHistory = !txLoading && hasHistoryBeyondCycle;

  useEffect(() => {
    if (!selectedPhone) return;
    // Force repaint on Android WebView
    requestAnimationFrame(() => {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
    });
  }, [selectedPhone, transactions]);

  const closeSheet = () => {
    setSelectedPhone(null);
    setTransactions([]);
    setTxNetworkStatus(null);
    setSheetShowFullHistory(false);
    setHasHistoryBeyondCycle(false);
    setFullHistoryLoaded(false);
    setFullHistoryTransactions([]);
    setFullHistoryNetworkStatus(null);
    setAmountSheetMode(null);
    setAmountValue("");
    setNameEditing(false);
    setNameDraft("");
    setSavingName(false);
  };

  const startNameEdit = () => {
    if (!selectedPhone) return;
    setNameDraft(selectedCustomerName);
    setNameEditing(true);
  };

  const cancelNameEdit = () => {
    setNameEditing(false);
    setNameDraft("");
  };

  const saveCustomerName = async () => {
    if (!vendorId || !selectedPhone || savingName) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;

    setSavingName(true);
    const { data: saved, error: saveError } = await supabase.rpc(
      "vendor_update_customer_name",
      {
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_customer_phone: selectedPhone,
        p_name: trimmed,
      },
    );

    if (saveError || !saved) {
      setSavingName(false);
      toast.error(saveError?.message ?? s.incoming_errCouldNotUpdate);
      return;
    }

    setCustomerNameByPhone((prev) => {
      const next = new Map(prev);
      next.set(selectedPhone, trimmed);
      return next;
    });
    setSavingName(false);
    setNameEditing(false);
    setNameDraft("");
    toast.success(s.ledger_customer_name_saved);
  };

  const toggleSheetFullHistory = () => {
    if (!hasAdditionalHistory) return;
    setSheetShowFullHistory((v) => {
      const next = !v;
      if (next && !fullHistoryLoaded && vendorId && selectedPhone) {
        setFullHistoryLoaded(true);
        void loadFullHistory(vendorId, selectedPhone, ledgerCycleStart);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!hasAdditionalHistory) setSheetShowFullHistory(false);
  }, [hasAdditionalHistory]);


  const openPaymentSheet = () => {
    if (!selectedEntry || selectedEntry.total_outstanding <= 0) return;
    setAmountValue(selectedEntry.total_outstanding.toFixed(2));
    setAmountSheetMode("payment");
  };

  const openRefundSheet = () => {
    if (!selectedEntry || selectedEntry.total_outstanding >= 0) return;
    setAmountValue(Math.abs(selectedEntry.total_outstanding).toFixed(2));
    setAmountSheetMode("refund");
  };

  const initiateCustomerCall = async () => {
    if (!selectedEntry?.user_phone || !vendorPhone) {
      toast.error(s.khata_callFailed);
      return;
    }

    setCallLoading(true);
    const result = await invokeInitiateCall({
      caller_phone: vendorPhone,
      vendor_phone: selectedEntry.user_phone.replace(/[\s\-+]/g, "").trim(),
      service_mode: vendorServiceMode,
    });
    setCallLoading(false);

    if (!result.success) {
      toast.error(s.khata_callFailed);
      return;
    }

    toast.success(s.khata_callInitiated);
  };

  const closeAmountSheet = () => {
    setAmountSheetMode(null);
    setAmountValue("");
  };

  const savePayment = async () => {
    if (!vendorId || !selectedPhone || !selectedEntry || amountSheetMode !== "payment" || !amountValid) return;
    if (savingAmountLockRef.current) return;

    savingAmountLockRef.current = true;
    setSavingAmount(true);

    const releaseSavingAmountLock = () => {
      savingAmountLockRef.current = false;
      setSavingAmount(false);
    };

    const amountPaid = parsedAmount;
    const now = new Date().toISOString();

    const { data: newOutstandingValue, error: paymentError } = await supabase.rpc(
      "vendor_record_khata_payment",
      {
        p_vendor_id: vendorId,
        p_vendor_phone: vendorPhone,
        p_customer_phone: selectedPhone,
        p_amount: amountPaid,
        p_note: s.khata_paymentReceivedNote,
      },
    );

    if (paymentError) {
      releaseSavingAmountLock();
      toast.error(paymentError.message);
      return;
    }

    const newOutstanding = Number(newOutstandingValue ?? 0);

    setEntries((prev) =>
      prev.map((e) =>
        e.user_phone === selectedPhone
          ? { ...e, total_outstanding: newOutstanding, last_updated: now }
          : e,
      ),
    );

    let linkedRequestId: string | null = null;
    if (newOutstanding === 0) {
      const phoneForRpc = (vendorPhone || getUserPhone() || "").trim();
      if (phoneForRpc) {
        const { data: linkedId, error: linkedErr } = await supabase.rpc(
          "get_vendor_khata_linked_request",
          {
            p_vendor_id: vendorId,
            p_vendor_phone: phoneForRpc,
            p_user_phone: selectedPhone,
          },
        );
        if (linkedErr) {
          captureError(linkedErr, { scope: "ledgerView.getKhataLinkedRequest", vendorId });
        }
        linkedRequestId = typeof linkedId === "string" ? linkedId : null;
      }
      const paidTitle = s.khata_paidNotifTitle;
      const paidBody = s.khata_paidNotifBody;
      void invokeNotifyUser({
        user_phone: selectedPhone,
        title: paidTitle,
        body: paidBody,
        type: "bill",
        ...(linkedRequestId ? { order_id: linkedRequestId } : {}),
      });
    }

    releaseSavingAmountLock();
    toast.success(s.khata_markedPaid);
    closeAmountSheet();
    void loadTransactions(vendorId, selectedPhone, ledgerCycleStart);
    if (fullHistoryLoaded) void loadFullHistory(vendorId, selectedPhone, ledgerCycleStart);
  };

  const saveRefund = async () => {
    if (!vendorId || !selectedPhone || !selectedEntry || amountSheetMode !== "refund" || !amountValid) return;
    if (savingAmountLockRef.current) return;

    savingAmountLockRef.current = true;
    setSavingAmount(true);

    const releaseSavingAmountLock = () => {
      savingAmountLockRef.current = false;
      setSavingAmount(false);
    };

    const refundAmount = parsedAmount;
    const now = new Date().toISOString();

    const { data, error: refundError } = await supabase.rpc("vendor_record_khata_refund", {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: selectedPhone,
      p_amount: refundAmount,
    });

    if (refundError) {
      releaseSavingAmountLock();
      toast.error(mapKhataRefundError(refundError.message, s));
      return;
    }

    const newOutstanding = Number(
      typeof data === "object" && data !== null && "total_outstanding" in data
        ? (data as { total_outstanding: number }).total_outstanding
        : 0,
    );

    setEntries((prev) =>
      prev.map((e) =>
        e.user_phone === selectedPhone
          ? { ...e, total_outstanding: newOutstanding, last_updated: now }
          : e,
      ),
    );

    releaseSavingAmountLock();
    toast.success(s.khata_refundSaved);
    closeAmountSheet();
    void loadTransactions(vendorId, selectedPhone, ledgerCycleStart);
    if (fullHistoryLoaded) void loadFullHistory(vendorId, selectedPhone, ledgerCycleStart);
  };

  return (
    <AppShell>
      <div className="space-y-3 pb-24" data-testid="ledger-screen" data-loading={String(loading)}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => navigate("/vendor")}
          className="ml-4 rounded-full border border-surface-border p-2 text-foreground active:scale-95"
          aria-label={s.khata_back}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 pr-4">
          <SettingsPageHeader title={`📒 ${s.khata_book}`} subtitle={shopName || " "} />
        </div>
      </div>

      {entriesNetworkStatus && (
        <NetworkErrorBanner
          status={entriesNetworkStatus}
          onRetry={
            entriesNetworkStatus === "failed"
              ? () => {
                  const { id, phone } = loadEntriesRetryRef.current;
                  if (id) void loadEntries(id, phone);
                }
              : undefined
          }
        />
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : entriesNetworkStatus === "failed" ? null : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">{s.khata_empty}</p>
      ) : (
        <div className="space-y-2">
          {visibleEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 mx-4">{s.khata_empty}</p>
          ) : (
            <SettingsCard>
              {visibleEntries.map((entry, idx) => (
                <button
                  key={entry.user_phone}
                  type="button"
                  onClick={() => openCustomer(entry.user_phone)}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-3.5 text-left active:scale-[0.99]",
                    idx < visibleEntries.length - 1 && "border-b border-surface-border",
                  )}
                >
                  <CustomerIdentity
                    phone={entry.user_phone}
                    customerNameByPhone={customerNameByPhone}
                    listLayout
                  />
                  {(() => {
                    const balance = formatKhataBalanceDisplay(
                      entry.total_outstanding,
                      s,
                      khataAmberLimit,
                      khataRedLimit,
                    );
                    return (
                      <span className={cn("text-sm font-bold tabular-nums", balance.colorClass)}>
                        {balance.text}
                      </span>
                    );
                  })()}
                </button>
              ))}
            </SettingsCard>
          )}
        </div>
      )}

      <Sheet open={selectedPhone != null} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl max-h-[85vh] flex flex-col"
          style={{
            transform: "translateZ(0)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <SheetHeader className="text-left pb-3 border-b border-surface-border">
            {selectedPhone && (
              <CustomerIdentity
                phone={selectedPhone}
                customerNameByPhone={customerNameByPhone}
              />
            )}
            {selectedPhone && (
              <div className="mt-2">
                {nameEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value.slice(0, 80))}
                      placeholder={s.ledger_customer_name_placeholder}
                      maxLength={80}
                      autoFocus
                      disabled={savingName}
                      className="flex-1 min-w-0 rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-brand disabled:opacity-50"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && nameDraft.trim()) void saveCustomerName();
                        if (e.key === "Escape") cancelNameEdit();
                      }}
                    />
                    <button
                      type="button"
                      disabled={savingName || !nameDraft.trim()}
                      onClick={() => void saveCustomerName()}
                      className="shrink-0 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground disabled:opacity-50"
                    >
                      {savingName ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        s.menu_save
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={savingName}
                      onClick={cancelNameEdit}
                      className="shrink-0 text-xs font-semibold text-muted-foreground disabled:opacity-50"
                    >
                      {s.settings_cancel}
                    </button>
                  </div>
                ) : selectedCustomerName ? (
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate flex-1">
                      {selectedCustomerName}
                    </p>
                    <button
                      type="button"
                      onClick={startNameEdit}
                      className="shrink-0 p-1.5 rounded-lg border border-surface-border text-muted-foreground active:text-brand"
                      aria-label={s.ledger_customer_name_placeholder}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={startNameEdit}
                    className="text-xs font-semibold text-brand active:opacity-80"
                  >
                    {s.ledger_customer_name_add}
                  </button>
                )}
              </div>
            )}
            {selectedEntry && (() => {
              const balance = formatKhataBalanceDisplay(
                selectedEntry.total_outstanding,
                s,
                khataAmberLimit,
                khataRedLimit,
              );
              return (
                <p
                  data-testid="ledger-balance"
                  className={cn("text-2xl font-bold tabular-nums mt-2", balance.colorClass)}
                >
                  {balance.text}
                </p>
              );
            })()}
            {selectedEntry?.user_phone && (
              <div className="mt-3">
                <button
                  type="button"
                  disabled={callLoading || !vendorPhone}
                  onClick={() => void initiateCustomerCall()}
                  className="w-full rounded-xl border border-brand/40 bg-brand/10 text-brand text-sm font-semibold py-2.5 active:scale-[0.99] disabled:opacity-50"
                >
                  {callLoading ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      {s.incoming_saving}
                    </span>
                  ) : (
                    s.khata_callCustomer
                  )}
                </button>
                <p className="text-[11px] text-muted-foreground text-center mt-1.5">
                  {s.khata_callHint}
                </p>
              </div>
            )}
          </SheetHeader>

          <div className="mt-4 space-y-3 px-1">
            {txNetworkStatus && (
              <NetworkErrorBanner
                status={txNetworkStatus}
                className="mb-0"
                onRetry={
                  txNetworkStatus === "failed"
                    ? () => {
                        const { id, userPhone } = loadTransactionsRetryRef.current;
                        if (id && userPhone) void loadTransactions(id, userPhone, ledgerCycleStart);
                      }
                    : undefined
                }
              />
            )}
            {txLoading && !txNetworkStatus ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : txNetworkStatus === "failed" ? null : transactions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">{s.khata_noTransactions}</p>
            ) : (
              <ul className="space-y-2">
                {transactions.map((tx) => (
                  <li
                    key={tx.id}
                    className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 space-y-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground">{formatKhataDate(tx.created_at)}</p>
                        <p
                          className={cn(
                            "text-sm font-medium leading-snug mt-0.5 whitespace-pre-wrap break-words",
                            tx.note?.trim() ? "text-foreground" : "text-muted-foreground italic",
                          )}
                        >
                          {tx.note?.trim() || s.khata_noDescription}
                        </p>
                      </div>
                      <p className="text-sm font-bold text-foreground tabular-nums shrink-0 text-right">
                        ₹{Number(tx.amount).toFixed(2)}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-semibold border-surface-border">
                      {khataPaymentModeLabel(tx.payment_mode, s)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}

            {hasAdditionalHistory && (
              <button
                type="button"
                onClick={toggleSheetFullHistory}
                className="w-full text-center text-xs text-muted-foreground underline pt-1"
              >
                {sheetShowFullHistory ? s.khata_hideFullHistory : s.khata_showFullHistory}
              </button>
            )}

            {hasAdditionalHistory && sheetShowFullHistory && fullHistoryNetworkStatus && (
              <NetworkErrorBanner
                status={fullHistoryNetworkStatus}
                className="mb-0"
                onRetry={
                  fullHistoryNetworkStatus === "failed"
                    ? () => {
                        const { id, userPhone, cycleStart } = loadFullHistoryRetryRef.current;
                        if (id && userPhone) void loadFullHistory(id, userPhone, cycleStart);
                      }
                    : undefined
                }
              />
            )}

            {hasAdditionalHistory && sheetShowFullHistory && fullHistoryLoading && !fullHistoryNetworkStatus && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {hasAdditionalHistory && sheetShowFullHistory && !fullHistoryLoading && !fullHistoryNetworkStatus && (
              <>
                <div className="border-t border-surface-border pt-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {s.khata_fullHistory.replace(
                      "{date}",
                      formatLedgerCycleStartLabel(ledgerCycleStart ?? ""),
                    )}
                  </p>
                </div>
                {fullHistoryTransactions.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {s.khata_noTransactionsInPeriod}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {fullHistoryTransactions.map((tx) => (
                      <li
                        key={tx.id}
                        className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 space-y-1"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-muted-foreground">
                              {formatKhataDate(tx.created_at)}
                            </p>
                            <p
                              className={cn(
                                "text-sm font-medium leading-snug mt-0.5 whitespace-pre-wrap break-words",
                                tx.note?.trim() ? "text-foreground" : "text-muted-foreground italic",
                              )}
                            >
                              {tx.note?.trim() || s.khata_noDescription}
                            </p>
                          </div>
                          <p className="text-sm font-bold text-foreground tabular-nums shrink-0 text-right">
                            ₹{Number(tx.amount).toFixed(2)}
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px] font-semibold border-surface-border">
                          {khataPaymentModeLabel(tx.payment_mode, s)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {selectedEntry && selectedEntry.total_outstanding > 0 && (
              <div className="border-t border-surface-border pt-4">
                <button
                  type="button"
                  data-testid="ledger-mark-paid-btn"
                  onClick={openPaymentSheet}
                  className="w-full rounded-2xl bg-brand text-page-bg py-4 font-bold active:scale-[0.99]"
                >
                  {s.khata_markPaid}
                </button>
              </div>
            )}

            {selectedEntry && selectedEntry.total_outstanding < 0 && (
              <div className="border-t border-surface-border pt-4">
                <button
                  type="button"
                  data-testid="ledger-record-refund-btn"
                  onClick={openRefundSheet}
                  className="w-full rounded-2xl bg-brand text-page-bg py-4 font-bold active:scale-[0.99]"
                >
                  {s.khata_recordRefund}
                </button>
              </div>
            )}
          </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={amountSheetMode != null} onOpenChange={(open) => !open && closeAmountSheet()}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl"
          style={{ transform: "translateZ(0)", WebkitOverflowScrolling: "touch" }}
        >
          <SheetHeader className="text-left">
            <SheetTitle>
              {amountSheetMode === "refund" ? s.khata_recordRefund : s.khata_recordPayment}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5" htmlFor="ledger-amount-input">
                {amountSheetMode === "refund" ? s.khata_refundAmount : s.khata_amountReceived}
              </label>
              <input
                id="ledger-amount-input"
                data-testid="ledger-partial-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amountValue}
                onChange={(e) => setAmountValue(e.target.value)}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {selectedEntry && amountSheetMode === "payment" && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {s.khata_outstandingAmount.replace(
                    "{amount}",
                    selectedEntry.total_outstanding.toFixed(2),
                  )}
                </p>
              )}
              {selectedEntry && amountSheetMode === "refund" && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {s.khata_creditOwedAmount.replace(
                    "{amount}",
                    Math.abs(selectedEntry.total_outstanding).toFixed(2),
                  )}
                </p>
              )}
            </div>
            <button
              type="button"
              data-testid="ledger-save-amount-btn"
              disabled={savingAmount || !amountValid}
              onClick={() =>
                void (amountSheetMode === "refund" ? saveRefund() : savePayment())
              }
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold disabled:opacity-50"
            >
              {savingAmount
                ? s.incoming_saving
                : amountSheetMode === "refund"
                  ? s.khata_saveRefund
                  : s.khata_savePayment}
            </button>
          </div>
        </SheetContent>
      </Sheet>
      </div>
    </AppShell>
  );
};

export default LedgerView;
