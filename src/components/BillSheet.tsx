import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Loader2, Mic, Trash2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase, invokeNotifyUser, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import { getVoiceLang } from "@/lib/voiceUtils";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  requestId: string;
  vendorId: string;
  userPhone: string | null;
  shopName: string;
  khataAmberLimit: number;
  khataRedLimit: number;
};

type BillItem = {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

function newBillItem(): BillItem {
  return {
    id: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unit: "",
    unit_price: 0,
  };
}

export function BillSheet({
  isOpen,
  onClose,
  requestId,
  vendorId,
  userPhone,
  shopName,
  khataAmberLimit,
  khataRedLimit,
}: Props) {
  const { s } = useLanguage();
  const [items, setItems] = useState<BillItem[]>([newBillItem()]);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "khata">("cash");
  const [sending, setSending] = useState(false);
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [currentOutstanding, setCurrentOutstanding] = useState<number | null>(null);
  const [loadingOutstanding, setLoadingOutstanding] = useState(false);
  const validItems = useMemo(
    () => items.filter((i) => i.description.trim() && i.unit_price > 0),
    [items],
  );

  const totalAmount = useMemo(
    () => validItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0),
    [validItems],
  );

  const projectedOutstanding =
    currentOutstanding != null ? currentOutstanding + totalAmount : null;
  const showKhataRedWarning =
    paymentMode === "khata" &&
    khataAmberLimit > 0 &&
    userPhone != null &&
    projectedOutstanding != null &&
    khataRedLimit > 0 &&
    projectedOutstanding >= khataRedLimit;
  const showKhataAmberWarning =
    paymentMode === "khata" &&
    khataAmberLimit > 0 &&
    userPhone != null &&
    projectedOutstanding != null &&
    !showKhataRedWarning &&
    projectedOutstanding >= khataAmberLimit;

  const fetchKhataOutstanding = useCallback(async () => {
    if (!userPhone || khataAmberLimit <= 0) {
      setCurrentOutstanding(null);
      return;
    }
    setLoadingOutstanding(true);
    const { data, error } = await supabase
      .from("khata_ledger")
      .select("total_outstanding")
      .eq("vendor_id", vendorId)
      .eq("user_phone", userPhone)
      .maybeSingle();
    setLoadingOutstanding(false);
    if (error) {
      setCurrentOutstanding(0);
      return;
    }
    setCurrentOutstanding(Number(data?.total_outstanding) || 0);
  }, [vendorId, userPhone, khataAmberLimit]);

  const selectPaymentMode = (mode: "cash" | "upi" | "khata") => {
    setPaymentMode(mode);
    if (mode === "khata") {
      void fetchKhataOutstanding();
    } else {
      setCurrentOutstanding(null);
    }
  };

  const updateItem = (id: string, patch: Partial<BillItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, newBillItem()]);
  };

  const removeItem = (id: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((i) => i.id !== id)));
  };

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setItems([newBillItem()]);
        setPaymentMode("cash");
        setNotes("");
        setSending(false);
        setIsListening(false);
        setIsProcessingImage(false);
        setCurrentOutstanding(null);
        setLoadingOutstanding(false);
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    // Force repaint on Android WebView
    requestAnimationFrame(() => {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
    });
  }, [isOpen, items]);

  const startVoiceBill = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.bill_voiceUnavailable);
        return;
      }
      await SpeechRecognition.requestPermissions();
      setIsListening(true);
      const speechResult = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      const text = speechResult?.matches?.[0]?.trim();
      if (!text) return;

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-voice-bill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ text }),
      });
      const result = await resp.json();
      if (result.success && result.items?.length) {
        setItems((prev) => {
          const hasEmpty = prev.length === 1 && !prev[0].description;
          const newItems = result.items.map(
            (i: {
              description?: string;
              quantity?: number;
              unit?: string;
              unit_price?: number;
            }) => ({
              id: crypto.randomUUID(),
              description: i.description ?? "",
              quantity: i.quantity ?? 1,
              unit: i.unit ?? "",
              unit_price: i.unit_price ?? 0,
            }),
          );
          return hasEmpty ? newItems : [...prev, ...newItems];
        });
        toast.success(s.bill_voiceParsed);
      } else {
        toast.error(s.voice_failed);
      }
    } catch {
      // user cancelled or denied — silent
    } finally {
      setIsListening(false);
    }
  };

  const startImageBill = async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.capture = "environment";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setIsProcessingImage(true);
        try {
          const base64 = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res((reader.result as string).split(",")[1]);
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
          const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-image-bill`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ image_base64: base64, media_type: file.type }),
          });
          const result = await resp.json();
          if (result.success && result.items?.length) {
            setItems((prev) => {
              const hasEmpty = prev.length === 1 && !prev[0].description;
              const newItems = result.items.map(
                (i: {
                  description?: string;
                  quantity?: number;
                  unit?: string;
                  unit_price?: number;
                }) => ({
                  id: crypto.randomUUID(),
                  description: i.description ?? "",
                  quantity: i.quantity ?? 1,
                  unit: i.unit ?? "",
                  unit_price: i.unit_price ?? 0,
                }),
              );
              return hasEmpty ? newItems : [...prev, ...newItems];
            });
            toast.success(s.bill_imageParsed);
          } else {
            toast.error(s.image_failed);
          }
        } catch {
          toast.error(s.image_failed);
        } finally {
          setIsProcessingImage(false);
        }
      };
      input.click();
    } catch {
      toast.error(s.image_failed);
      setIsProcessingImage(false);
    }
  };

  const voidExistingUnpaidBills = async () => {
    await supabase
      .from("order_bills")
      .update({ payment_status: "void" })
      .eq("request_id", requestId)
      .neq("payment_status", "paid");
  };

  const executeSendBill = async (opts?: { isReplace?: boolean }) => {
    const rpcItems = validItems.map((i) => ({
      name: i.description.trim(),
      quantity: i.quantity,
      unit_price: i.unit_price,
      unit: i.unit.trim() || null,
    }));

    const { data: billId, error: billError } = await supabase.rpc("insert_bill_with_items", {
      p_order_id: requestId,
      p_vendor_id: vendorId,
      p_customer_phone: userPhone,
      p_total: totalAmount,
      p_payment_mode: paymentMode,
      p_payment_status: "unpaid",
      p_notes: notes.trim() || null,
      p_items: rpcItems,
    });

    if (billError || !billId) {
      toast.error(s.bill_sendFailed);
      setSending(false);
      return;
    }

    const phone = userPhone?.trim();
    if (phone) {
      const title = s.bill_notifTitle;
      const body = `${shopName}: ₹${Math.round(totalAmount)} — ${paymentMode}`;
      void invokeNotifyUser({
        user_phone: phone,
        title,
        body,
        type: "bill",
        order_id: requestId,
      });
    }

    toast.success(s.bill_sent);
    setSending(false);
    onClose();
  };

  const sendBill = async () => {
    if (!validItems.length) return;

    const { data: existingBills, error: checkError } = await supabase
      .from("order_bills")
      .select("id")
      .eq("request_id", requestId)
      .neq("payment_status", "void")
      .limit(1);

    if (checkError) {
      toast.error(s.bill_sendFailed);
      return;
    }

    if (existingBills && existingBills.length > 0) {
      setReplaceDialogOpen(true);
      return;
    }

    setSending(true);
    await executeSendBill();
  };

  const confirmReplaceBill = async () => {
    setReplaceDialogOpen(false);
    setSending(true);
    await voidExistingUnpaidBills();
    await executeSendBill({ isReplace: true });
  };

  return (
    <>
    <AlertDialog open={replaceDialogOpen} onOpenChange={setReplaceDialogOpen}>
      <AlertDialogContent className="rounded-2xl border border-border bg-card">
        <AlertDialogHeader>
          <AlertDialogTitle>{s.bill_already_sent_title}</AlertDialogTitle>
          <AlertDialogDescription>{s.bill_already_sent_body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={sending}
            onClick={(e) => {
              e.preventDefault();
              void confirmReplaceBill();
            }}
          >
            {s.bill_send}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        data-testid="bill-sheet"
        side="bottom"
        className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[90vh] flex flex-col [&>button]:text-muted-foreground"
        style={{
          transform: "translateZ(0)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <SheetHeader className="sr-only">
          <SheetTitle>{s.bill_title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pt-2 pr-2">
          <div className="flex items-start justify-between gap-2">
            <SettingsPageHeader title={s.bill_title} subtitle={shopName} />
            <div className="flex items-center gap-2 shrink-0 pt-2">
              <button
                type="button"
                onClick={() => void startImageBill()}
                disabled={isProcessingImage}
                className="p-2 rounded-xl border border-surface-border bg-surface text-gray-400 hover:text-brand disabled:opacity-50"
              >
                {isProcessingImage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
              </button>
              {Capacitor.isNativePlatform() &&
                (isListening ? (
                  <div className="flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/10 px-3 py-2 shrink-0">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                    <span className="text-xs font-semibold text-red-500 whitespace-nowrap">
                      {s.bill_listening}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startVoiceBill()}
                    className="p-2 rounded-xl border border-surface-border bg-surface text-gray-400 hover:text-brand transition-colors shrink-0"
                    aria-label={s.bill_voicePrompt}
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                ))}
            </div>
          </div>

          <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-[11px] leading-snug text-warning mb-3">
            {s.bill_editWarning}
          </p>

        <SettingsCard className="mx-0 mb-3">
            {items.map((item, idx) => {
              const lineTotal = item.quantity * item.unit_price;
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5",
                    idx < items.length - 1 && "border-b border-surface-border",
                  )}
                >
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) =>
                      updateItem(item.id, { description: e.target.value })
                    }
                    placeholder={s.bill_itemName}
                    className="flex-1 min-w-0 rounded-lg border border-surface-border bg-surface px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
                  />
                  <input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) =>
                      updateItem(item.id, {
                        quantity: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                    className="w-12 rounded-lg border border-surface-border bg-surface px-1 py-1.5 text-sm text-foreground text-center focus:outline-none focus:border-brand"
                    aria-label="Quantity"
                  />
                  <div className="relative w-16 shrink-0">
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      ₹
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={item.unit_price || ""}
                      onChange={(e) =>
                        updateItem(item.id, {
                          unit_price: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                      className="w-full rounded-lg border border-surface-border bg-surface pl-5 pr-1 py-1.5 text-sm text-foreground text-right focus:outline-none focus:border-brand"
                      aria-label="Unit price"
                    />
                  </div>
                  <p className="w-12 shrink-0 text-right text-sm font-bold tabular-nums text-brand">
                    ₹{lineTotal.toFixed(0)}
                  </p>
                  {items.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="shrink-0 p-1 text-muted-foreground active:text-destructive"
                      aria-label="Remove item"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : (
                    <span className="w-5 shrink-0" aria-hidden />
                  )}
                </div>
              );
            })}
        </SettingsCard>

          <button
            type="button"
            onClick={addItem}
            className="w-full rounded-xl border border-dashed border-brand/30 text-brand text-sm font-semibold py-2.5 active:bg-brand/5 transition-colors mb-3"
          >
            {s.bill_addItem}
          </button>

          <div className="border-t-2 border-surface-border mt-2 pt-3 flex items-center justify-between">
            <span className="font-bold text-foreground">{s.bill_total}</span>
            <span
              data-testid="bill-total-input"
              className="text-xl font-bold text-brand tabular-nums"
            >
              ₹{totalAmount.toFixed(0)}
            </span>
          </div>

          <div className="flex flex-wrap gap-2 mt-3" data-testid="bill-payment-mode-select">
            <button
              type="button"
              onClick={() => selectPaymentMode("cash")}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
                paymentMode === "cash"
                  ? "bg-brand text-white border-brand"
                  : "border-surface-border text-muted-foreground bg-surface",
              )}
            >
              {s.bill_cash}
            </button>
            <button
              type="button"
              onClick={() => selectPaymentMode("upi")}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
                paymentMode === "upi"
                  ? "bg-brand text-white border-brand"
                  : "border-surface-border text-muted-foreground bg-surface",
              )}
            >
              {s.bill_upi}
            </button>
            <button
              type="button"
              onClick={() => selectPaymentMode("khata")}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
                paymentMode === "khata"
                  ? "bg-brand text-white border-brand"
                  : "border-surface-border text-muted-foreground bg-surface",
              )}
            >
              {s.bill_khata}
            </button>
          </div>

          {paymentMode === "khata" && (
            <p className="text-[11px] text-muted-foreground text-center">
              {s.bill_khataHint}
            </p>
          )}

          {showKhataRedWarning && (
            <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-[11px] leading-snug text-red-600 dark:text-red-400">
              {s.khata_billWillExceedRed}
            </p>
          )}
          {showKhataAmberWarning && (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
              {s.khata_billWillExceedAmber}
            </p>
          )}
          {paymentMode === "khata" && khataAmberLimit > 0 && userPhone && loadingOutstanding && (
            <p className="text-[11px] text-muted-foreground text-center">
              {s.incoming_saving}
            </p>
          )}

          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={s.bill_notes}
            className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
          />

          <button
            type="button"
            data-testid="bill-submit-btn"
            disabled={sending || validItems.length === 0}
            onClick={() => void sendBill()}
            className="w-full rounded-2xl bg-brand text-white py-4 font-bold active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
          >
            {sending ? s.incoming_saving : s.bill_send}
          </button>
        </div>
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
