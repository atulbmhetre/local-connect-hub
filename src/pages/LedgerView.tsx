import { useCallback, useEffect, useState } from "react";
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
import { saveNotification } from "@/lib/notifications";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import {
  currentCycleTransactions,
  filterKhataLedgerByOutstanding,
  formatKhataDate,
  formatLedgerCycleStartLabel,
  khataPaymentModeLabel,
  ledgerCycleStartIso,
  maskPhoneLast4,
} from "@/lib/khataDisplay";

const STORAGE_KEY = "aaspaas:vendor_id";

type LedgerEntry = {
  user_phone: string;
  total_outstanding: number;
  last_updated: string;
};

function khataOutstandingColorClass(
  outstanding: number,
  amberLimit: number,
  redLimit: number,
): string {
  if (redLimit > 0 && outstanding >= redLimit) return "text-red-400";
  if (amberLimit > 0 && outstanding >= amberLimit) return "text-amber-400";
  return "text-green-400";
}

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
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<KhataTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [callLoading, setCallLoading] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [sheetShowFullHistory, setSheetShowFullHistory] = useState(false);
  const [fullHistoryTransactions, setFullHistoryTransactions] = useState<KhataTransaction[]>([]);
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  const selectedEntry = entries.find((e) => e.user_phone === selectedPhone) ?? null;
  const selectedCustomerName = selectedPhone
    ? customerNameByPhone.get(selectedPhone)?.trim() ?? ""
    : "";
  const visibleEntries = filterKhataLedgerByOutstanding(entries, false);
  const parsedPaymentAmount = parseFloat(paymentAmount);
  const paymentValid =
    selectedEntry != null &&
    Number.isFinite(parsedPaymentAmount) &&
    parsedPaymentAmount > 0 &&
    parsedPaymentAmount <= selectedEntry.total_outstanding;

  const loadEntries = useCallback(async (id: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("khata_ledger")
      .select("user_phone, total_outstanding, last_updated")
      .eq("vendor_id", id)
      .order("last_updated", { ascending: false });
    if (error) {
      toast.error(error.message);
      setEntries([]);
      setCustomerNameByPhone(new Map());
      setLoading(false);
      return;
    }

    const ledgerRows = data ?? [];
    setEntries(ledgerRows);

    const phones = [
      ...new Set(
        ledgerRows
          .map((row) => row.user_phone)
          .filter((p): p is string => typeof p === "string" && p.length > 0),
      ),
    ];

    if (phones.length === 0) {
      setCustomerNameByPhone(new Map());
      setLoading(false);
      return;
    }

    const { data: appUsers, error: namesError } = await supabase
      .from("app_users")
      .select("phone, name")
      .in("phone", phones);

    if (namesError) {
      console.error("loadCustomerNames", namesError);
      setCustomerNameByPhone(new Map());
    } else {
      const nameMap = new Map<string, string>();
      for (const row of appUsers ?? []) {
        const phone = row.phone;
        const name = typeof row.name === "string" ? row.name.trim() : "";
        if (phone && name) nameMap.set(phone, name);
      }
      setCustomerNameByPhone(nameMap);
    }

    setLoading(false);
  }, []);

  const loadTransactions = useCallback(async (id: string, userPhone: string) => {
    setTxLoading(true);
    const { data, error } = await supabase
      .from("khata_transactions")
      .select("id, amount, note, payment_mode, created_at")
      .eq("vendor_id", id)
      .eq("user_phone", userPhone)
      .order("created_at", { ascending: true });
    if (error) {
      toast.error(error.message);
      setTransactions([]);
    } else {
      const chronological = (data ?? []) as KhataTransaction[];
      setTransactions(currentCycleTransactions(chronological));
    }
    setTxLoading(false);
  }, []);

  useEffect(() => {
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id?.trim()) {
      navigate("/vendor", { replace: true });
      return;
    }
    setVendorId(id);
    void (async () => {
      const { data: vendor } = await supabase
        .from("vendors")
        .select(
          "shop_name, ledger_cycle_start, khata_amber_limit, khata_red_limit, phone, service_mode",
        )
        .eq("id", id)
        .maybeSingle();
      setShopName(vendor?.shop_name ?? "");
      setLedgerCycleStart(vendor?.ledger_cycle_start ?? null);
      setKhataAmberLimit(Number(vendor?.khata_amber_limit) || 0);
      setKhataRedLimit(Number(vendor?.khata_red_limit) || 0);
      setVendorPhone((vendor?.phone ?? "").replace(/[\s\-+]/g, "").trim());
      setVendorServiceMode(vendor?.service_mode ?? "help");
      await loadEntries(id);
    })();
  }, [navigate, loadEntries]);

  const loadFullHistory = useCallback(
    async (id: string, userPhone: string, cycleStart: string | null) => {
      setFullHistoryLoading(true);
      const since = ledgerCycleStartIso(cycleStart);
      const { data, error } = await supabase
        .from("khata_transactions")
        .select("id, amount, note, payment_mode, created_at")
        .eq("vendor_id", id)
        .eq("user_phone", userPhone)
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      if (error) {
        toast.error(error.message);
        setFullHistoryTransactions([]);
      } else {
        setFullHistoryTransactions((data ?? []) as KhataTransaction[]);
      }
      setFullHistoryLoading(false);
    },
    [],
  );

  const openCustomer = (userPhone: string) => {
    setSelectedPhone(userPhone);
    setNameEditing(false);
    setNameDraft("");
    setSheetShowFullHistory(false);
    setFullHistoryTransactions([]);
    if (vendorId) {
      void loadTransactions(vendorId, userPhone);
      void loadFullHistory(vendorId, userPhone, ledgerCycleStart);
    }
  };

  const hasAdditionalHistory =
    !txLoading &&
    !fullHistoryLoading &&
    fullHistoryTransactions.length > transactions.length;

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
    setSheetShowFullHistory(false);
    setFullHistoryTransactions([]);
    setPaymentOpen(false);
    setPaymentAmount("");
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
    if (!selectedPhone || savingName) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;

    setSavingName(true);
    const { data: updated, error: updateError } = await supabase
      .from("app_users")
      .update({ name: trimmed })
      .eq("phone", selectedPhone)
      .select("phone");

    if (updateError) {
      setSavingName(false);
      toast.error(updateError.message);
      return;
    }

    if (!updated?.length) {
      const { error: insertError } = await supabase
        .from("app_users")
        .insert({ phone: selectedPhone, name: trimmed });
      if (insertError) {
        setSavingName(false);
        toast.error(insertError.message);
        return;
      }
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
    setSheetShowFullHistory((v) => !v);
  };

  useEffect(() => {
    if (!hasAdditionalHistory) setSheetShowFullHistory(false);
  }, [hasAdditionalHistory]);


  const openPaymentSheet = () => {
    if (!selectedEntry || selectedEntry.total_outstanding <= 0) return;
    setPaymentAmount(selectedEntry.total_outstanding.toFixed(2));
    setPaymentOpen(true);
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

  const closePaymentSheet = () => {
    setPaymentOpen(false);
    setPaymentAmount("");
  };

  const savePayment = async () => {
    if (!vendorId || !selectedPhone || !selectedEntry || !paymentValid) return;

    const amountPaid = parsedPaymentAmount;
    const now = new Date().toISOString();

    setSavingPayment(true);

    const { error: txError } = await supabase.from("khata_transactions").insert({
      vendor_id: vendorId,
      user_phone: selectedPhone,
      amount: amountPaid,
      note: s.khata_paymentReceivedNote,
      payment_mode: "paid",
      created_at: now,
    });

    if (txError) {
      setSavingPayment(false);
      toast.error(txError.message);
      return;
    }

    const { data: ledgerRow, error: readError } = await supabase
      .from("khata_ledger")
      .select("total_outstanding")
      .eq("vendor_id", vendorId)
      .eq("user_phone", selectedPhone)
      .maybeSingle();

    if (readError) {
      setSavingPayment(false);
      toast.error(readError.message);
      return;
    }

    const freshValue = Number(ledgerRow?.total_outstanding ?? 0);
    const newOutstanding = Math.max(0, freshValue - amountPaid);

    const { error: ledgerError } = await supabase
      .from("khata_ledger")
      .update({ total_outstanding: newOutstanding, last_updated: now })
      .eq("vendor_id", vendorId)
      .eq("user_phone", selectedPhone);

    if (ledgerError) {
      setSavingPayment(false);
      toast.error(ledgerError.message);
      return;
    }

    setEntries((prev) =>
      prev.map((e) =>
        e.user_phone === selectedPhone
          ? { ...e, total_outstanding: newOutstanding, last_updated: now }
          : e,
      ),
    );

    const { data: linkedKhataTx } =
      newOutstanding === 0
        ? await supabase
            .from("khata_transactions")
            .select("request_id")
            .eq("vendor_id", vendorId)
            .eq("user_phone", selectedPhone)
            .not("request_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null };

    if (newOutstanding === 0) {
      await supabase
        .from("order_bills")
        .update({ payment_status: "paid", paid_at: now })
        .eq("user_phone", selectedPhone)
        .eq("vendor_id", vendorId)
        .eq("payment_mode", "khata")
        .eq("payment_status", "unpaid");

      const paidTitle = s.khata_paidNotifTitle;
      const paidBody = s.khata_paidNotifBody;
      void invokeNotifyUser({
        user_phone: selectedPhone,
        title: paidTitle,
        body: paidBody,
        type: "bill",
        ...(linkedKhataTx?.request_id ? { order_id: linkedKhataTx.request_id } : {}),
      });
      saveNotification({
        userPhone: selectedPhone,
        type: "bill",
        title: paidTitle,
        body: paidBody,
        route: "my-orders",
        ...(linkedKhataTx?.request_id
          ? { routeParams: { order_id: linkedKhataTx.request_id } }
          : {}),
        isInformational: false,
      });
    } else {
      const partialTitle = s.khata_partial_paid_title;
      const partialBody = s.khata_partial_paid_body
        .replace("{amount}", amountPaid.toFixed(0))
        .replace("{shop}", shopName || "vendor")
        .replace("{outstanding}", newOutstanding.toFixed(0));
      saveNotification({
        userPhone: selectedPhone,
        type: "bill",
        title: partialTitle,
        body: partialBody,
        route: "my-orders",
        isInformational: false,
      });
    }

    setSavingPayment(false);
    toast.success(s.khata_markedPaid);
    closePaymentSheet();
    void loadTransactions(vendorId, selectedPhone);
    void loadFullHistory(vendorId, selectedPhone, ledgerCycleStart);
  };

  return (
    <AppShell>
      <div className="space-y-3 pb-24" data-testid="ledger-screen">
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

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : entries.length === 0 ? (
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
                  <span
                    className={cn(
                      "text-sm font-bold tabular-nums",
                      khataOutstandingColorClass(
                        entry.total_outstanding,
                        khataAmberLimit,
                        khataRedLimit,
                      ),
                    )}
                  >
                    ₹{entry.total_outstanding.toFixed(2)}
                  </span>
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
            {selectedEntry && (
              <p
                data-testid="ledger-balance"
                className={cn(
                  "text-2xl font-bold tabular-nums mt-2",
                  khataOutstandingColorClass(
                    selectedEntry.total_outstanding,
                    khataAmberLimit,
                    khataRedLimit,
                  ),
                )}
              >
                ₹{selectedEntry.total_outstanding.toFixed(2)}
              </p>
            )}
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
            {txLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : transactions.length === 0 ? (
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

            {hasAdditionalHistory && sheetShowFullHistory && !fullHistoryLoading && (
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
          </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={paymentOpen} onOpenChange={(open) => !open && closePaymentSheet()}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl"
          style={{ transform: "translateZ(0)", WebkitOverflowScrolling: "touch" }}
        >
          <SheetHeader className="text-left">
            <SheetTitle>{s.khata_recordPayment}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5" htmlFor="payment-amount">
                {s.khata_amountReceived}
              </label>
              <input
                id="payment-amount"
                data-testid="ledger-partial-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {selectedEntry && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {s.khata_outstandingAmount.replace(
                    "{amount}",
                    selectedEntry.total_outstanding.toFixed(2),
                  )}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={savingPayment || !paymentValid}
              onClick={() => void savePayment()}
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold disabled:opacity-50"
            >
              {savingPayment ? s.incoming_saving : s.khata_savePayment}
            </button>
          </div>
        </SheetContent>
      </Sheet>
      </div>
    </AppShell>
  );
};

export default LedgerView;
