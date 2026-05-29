import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import {
  formatKhataDate,
  khataPaymentModeLabel,
  maskPhoneLast4,
} from "@/lib/khataDisplay";

const STORAGE_KEY = "aaspaas:vendor_id";

type LedgerEntry = {
  user_phone: string;
  total_outstanding: number;
  last_updated: string;
};

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
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<KhataTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);

  const selectedEntry = entries.find((e) => e.user_phone === selectedPhone) ?? null;
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
    } else {
      setEntries(data ?? []);
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
      .order("created_at", { ascending: false });
    if (error) {
      toast.error(error.message);
      setTransactions([]);
    } else {
      setTransactions((data ?? []) as KhataTransaction[]);
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
        .select("shop_name")
        .eq("id", id)
        .maybeSingle();
      setShopName(vendor?.shop_name ?? "");
      await loadEntries(id);
    })();
  }, [navigate, loadEntries]);

  const openCustomer = (userPhone: string) => {
    setSelectedPhone(userPhone);
    if (vendorId) void loadTransactions(vendorId, userPhone);
  };

  const closeSheet = () => {
    setSelectedPhone(null);
    setTransactions([]);
    setPaymentOpen(false);
    setPaymentAmount("");
  };

  const openPaymentSheet = () => {
    if (!selectedEntry || selectedEntry.total_outstanding <= 0) return;
    setPaymentAmount(selectedEntry.total_outstanding.toFixed(2));
    setPaymentOpen(true);
  };

  const closePaymentSheet = () => {
    setPaymentOpen(false);
    setPaymentAmount("");
  };

  const savePayment = async () => {
    if (!vendorId || !selectedPhone || !selectedEntry || !paymentValid) return;

    const amountReceived = parsedPaymentAmount;
    const remaining = Math.max(
      0,
      Math.round((selectedEntry.total_outstanding - amountReceived) * 100) / 100,
    );
    const now = new Date().toISOString();

    setSavingPayment(true);

    const { error: txError } = await supabase.from("khata_transactions").insert({
      vendor_id: vendorId,
      user_phone: selectedPhone,
      amount: amountReceived,
      note: "Payment received",
      payment_mode: "paid",
      created_at: now,
    });

    if (txError) {
      setSavingPayment(false);
      toast.error(txError.message);
      return;
    }

    const { error: ledgerError } = await supabase
      .from("khata_ledger")
      .update({ total_outstanding: remaining, last_updated: now })
      .eq("vendor_id", vendorId)
      .eq("user_phone", selectedPhone);

    if (ledgerError) {
      setSavingPayment(false);
      toast.error(ledgerError.message);
      return;
    }

    setSavingPayment(false);
    toast.success(s.khata_markedPaid);
    closePaymentSheet();

    if (remaining <= 0) {
      setEntries((prev) => prev.filter((e) => e.user_phone !== selectedPhone));
      closeSheet();
    } else {
      setEntries((prev) =>
        prev.map((e) =>
          e.user_phone === selectedPhone
            ? { ...e, total_outstanding: remaining, last_updated: now }
            : e,
        ),
      );
      void loadTransactions(vendorId, selectedPhone);
    }
  };

  return (
    <AppShell>
      <header className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => navigate("/vendor")}
          className="rounded-full border border-border p-2 text-foreground active:scale-95"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="font-display text-xl font-bold text-foreground">📒 {s.khata_book}</h1>
          {shopName && (
            <p className="text-xs text-muted-foreground mt-0.5">{shopName}</p>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">{s.khata_empty}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.user_phone}>
              <button
                type="button"
                onClick={() => openCustomer(entry.user_phone)}
                className="w-full flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left active:scale-[0.99]"
              >
                <span className="text-sm font-semibold text-foreground tabular-nums">
                  {maskPhoneLast4(entry.user_phone)}
                </span>
                <span
                  className={cn(
                    "text-sm font-bold tabular-nums",
                    entry.total_outstanding > 0 ? "text-warning" : "text-green-600",
                  )}
                >
                  ₹{entry.total_outstanding.toFixed(2)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={selectedPhone != null} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[85vh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle className="tabular-nums">
              {selectedPhone ? maskPhoneLast4(selectedPhone) : ""}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4 space-y-3">
            {txLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : transactions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No transactions</p>
            ) : (
              <ul className="space-y-2">
                {transactions.map((tx) => (
                  <li
                    key={tx.id}
                    className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 space-y-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-muted-foreground">{formatKhataDate(tx.created_at)}</p>
                      <p className="text-sm font-bold text-foreground tabular-nums">
                        ₹{Number(tx.amount).toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-foreground mb-1">Service</p>
                      <p
                        className={cn(
                          "text-sm leading-snug",
                          tx.note?.trim()
                            ? "text-foreground font-medium"
                            : "text-muted-foreground italic",
                        )}
                      >
                        {tx.note?.trim() || "No description"}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-semibold">
                      {khataPaymentModeLabel(tx.payment_mode, s)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}

            {selectedEntry && (
              <div className="border-t border-border pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Total outstanding</span>
                  <span
                    className={cn(
                      "text-lg font-bold tabular-nums",
                      selectedEntry.total_outstanding > 0 ? "text-warning" : "text-green-600",
                    )}
                  >
                    ₹{selectedEntry.total_outstanding.toFixed(2)}
                  </span>
                </div>
                {selectedEntry.total_outstanding > 0 && (
                  <button
                    type="button"
                    onClick={openPaymentSheet}
                    className="w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold"
                  >
                    {s.khata_markPaid}
                  </button>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={paymentOpen} onOpenChange={(open) => !open && closePaymentSheet()}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle>Record Payment</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5" htmlFor="payment-amount">
                Amount received
              </label>
              <input
                id="payment-amount"
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
                  Outstanding: ₹{selectedEntry.total_outstanding.toFixed(2)}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={savingPayment || !paymentValid}
              onClick={() => void savePayment()}
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold disabled:opacity-50"
            >
              {savingPayment ? "…" : "Save Payment"}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
};

export default LedgerView;
