import { useCallback, useMemo, useState } from "react";
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
  supabase,
  invokeNotifyUser,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { getVoiceLang } from "@/lib/voiceUtils";

const VOICE_LANG_OPTIONS = ["en-IN", "hi-IN", "mr-IN"] as const;

function voiceLangShort(code: string): string {
  if (code === "hi-IN") return "HI";
  if (code === "mr-IN") return "MR";
  return "EN";
}

function nextVoiceLang(current: string): (typeof VOICE_LANG_OPTIONS)[number] {
  const idx = VOICE_LANG_OPTIONS.indexOf(current as (typeof VOICE_LANG_OPTIONS)[number]);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % VOICE_LANG_OPTIONS.length;
  return VOICE_LANG_OPTIONS[nextIdx];
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  requestId: string;
  vendorId: string;
  userPhone: string | null;
  shopName: string;
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
}: Props) {
  const { s } = useLanguage();
  const [items, setItems] = useState<BillItem[]>([newBillItem()]);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "khata">("cash");
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [voiceLangOverride, setVoiceLangOverride] = useState<string | null>(null);
  const activeVoiceLang = voiceLangOverride ?? getVoiceLang();

  const validItems = useMemo(
    () => items.filter((i) => i.description.trim() && i.unit_price > 0),
    [items],
  );

  const totalAmount = useMemo(
    () => validItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0),
    [validItems],
  );

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
        setVoiceLangOverride(null);
        onClose();
      }
    },
    [onClose],
  );

  const startVoiceBill = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error("Voice not available");
        return;
      }
      await SpeechRecognition.requestPermissions();
      setIsListening(true);
      const speechResult = await SpeechRecognition.start({
        language: activeVoiceLang,
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

  const sendBill = async () => {
    if (!validItems.length) return;

    setSending(true);

    const { data: bill, error: billError } = await supabase
      .from("order_bills")
      .insert({
        request_id: requestId,
        vendor_id: vendorId,
        user_phone: userPhone,
        total_amount: totalAmount,
        payment_mode: paymentMode,
        payment_status: "unpaid",
        notes: notes.trim() || null,
      })
      .select()
      .single();

    if (billError || !bill) {
      toast.error(s.bill_sendFailed);
      setSending(false);
      return;
    }

    await supabase.from("order_items").insert(
      validItems.map((i) => ({
        request_id: requestId,
        description: i.description.trim(),
        quantity: i.quantity,
        unit: i.unit.trim() || null,
        unit_price: i.unit_price,
      })),
    );

    if (paymentMode === "khata" && userPhone) {
      const { data: existing } = await supabase
        .from("khata_ledger")
        .select("total_outstanding")
        .eq("vendor_id", vendorId)
        .eq("user_phone", userPhone)
        .single();

      const currentOutstanding = existing?.total_outstanding ?? 0;

      await supabase.from("khata_ledger").upsert(
        {
          vendor_id: vendorId,
          user_phone: userPhone,
          total_outstanding: currentOutstanding + totalAmount,
          last_updated: new Date().toISOString(),
        },
        { onConflict: "vendor_id,user_phone" },
      );
    }

    if (userPhone) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.bill_notifTitle,
        body: `${shopName}: ₹${totalAmount} — ${paymentMode}`,
      });
    }

    toast.success(s.bill_sent);
    setSending(false);
    onClose();
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl max-h-[90vh] overflow-y-auto [&>button]:text-gray-400"
      >
        <SheetHeader className="text-left space-y-1 pr-8">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="text-white font-display text-lg">
                {s.bill_title}
              </SheetTitle>
              <p className="text-sm text-gray-400">{shopName}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
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
                      Listening... speak now
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void startVoiceBill()}
                      className="p-2 rounded-xl border border-surface-border bg-surface text-gray-400 hover:text-brand transition-colors"
                      aria-label={s.bill_voicePrompt}
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setVoiceLangOverride(nextVoiceLang(activeVoiceLang))}
                      className="flex items-center gap-0.5 rounded-lg border border-surface-border bg-surface px-2 py-1.5 text-[10px] font-bold"
                      aria-label="Voice language"
                    >
                      {VOICE_LANG_OPTIONS.map((code, i) => (
                        <span key={code} className="flex items-center gap-0.5">
                          {i > 0 && <span className="text-muted-foreground font-normal">|</span>}
                          <span
                            className={
                              activeVoiceLang === code ? "text-brand" : "text-muted-foreground"
                            }
                          >
                            {voiceLangShort(code)}
                          </span>
                        </span>
                      ))}
                    </button>
                  </div>
                ))}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-5 space-y-3">
          <div className="space-y-2">
            {items.map((item) => {
              const lineTotal = item.quantity * item.unit_price;
              return (
                <div key={item.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) =>
                      updateItem(item.id, { description: e.target.value })
                    }
                    placeholder={s.bill_itemName}
                    className="flex-1 min-w-0 rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
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
                    className="w-16 rounded-xl border border-surface-border bg-surface px-2 py-2 text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-brand/50"
                    aria-label="Quantity"
                  />
                  <div className="relative w-20 shrink-0">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">
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
                      className="w-full rounded-xl border border-surface-border bg-surface pl-6 pr-2 py-2 text-sm text-white text-right focus:outline-none focus:ring-2 focus:ring-brand/50"
                      aria-label="Unit price"
                    />
                  </div>
                  <p className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums text-white">
                    ₹{lineTotal.toFixed(0)}
                  </p>
                  {items.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="shrink-0 p-1.5 text-gray-400 hover:text-destructive transition-colors"
                      aria-label="Remove item"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : (
                    <span className="w-7 shrink-0" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addItem}
            className="w-full rounded-xl border border-dashed border-brand/40 text-brand text-sm font-semibold py-2.5 hover:bg-brand/5 transition-colors"
          >
            {s.bill_addItem}
          </button>

          <div className="border-t border-surface-border pt-3">
            <div className="flex items-center justify-between text-base font-semibold">
              <span>{s.bill_total}</span>
              <span className="tabular-nums">₹{totalAmount.toFixed(0)}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setPaymentMode("cash")}
              className={cn(
                "rounded-xl border-2 py-2.5 text-xs font-semibold transition-colors",
                paymentMode === "cash"
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-surface-border bg-surface text-gray-400",
              )}
            >
              {s.bill_cash}
            </button>
            <button
              type="button"
              onClick={() => setPaymentMode("upi")}
              className={cn(
                "rounded-xl border-2 py-2.5 text-xs font-semibold transition-colors",
                paymentMode === "upi"
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-surface-border bg-surface text-gray-400",
              )}
            >
              {s.bill_upi}
            </button>
            <button
              type="button"
              onClick={() => setPaymentMode("khata")}
              className={cn(
                "rounded-xl border-2 py-2.5 text-xs font-semibold transition-colors",
                paymentMode === "khata"
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-surface-border bg-surface text-gray-400",
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

          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={s.bill_notes}
            className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
          />

          <button
            type="button"
            disabled={sending || validItems.length === 0}
            onClick={() => void sendBill()}
            className="w-full rounded-xl bg-brand text-page-bg py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
          >
            {sending ? "..." : s.bill_send}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
