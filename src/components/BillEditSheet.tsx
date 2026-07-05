import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
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
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import {
  computeCustomerCreditAmount,
  fetchBillLineItems,
  newBillEditLineItem,
  parseBillEditErrorCode,
  toRpcBillItems,
  type BillEditLineItem,
  type VendorEditBillResult,
} from "@/lib/billEdit";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  billId: string;
  requestId: string;
  vendorId: string;
  userPhone: string | null;
  shopName: string;
  originalTotal: number;
  paymentMode: "cash" | "upi" | "khata";
  paymentStatus: string;
  onSuccess: (result: VendorEditBillResult) => void;
};

export function BillEditSheet({
  isOpen,
  onClose,
  billId,
  requestId,
  vendorId,
  userPhone,
  shopName,
  originalTotal,
  paymentMode,
  paymentStatus,
  onSuccess,
}: Props) {
  const { s } = useLanguage();
  const [items, setItems] = useState<BillEditLineItem[]>([newBillEditLineItem()]);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lateEditDialogOpen, setLateEditDialogOpen] = useState(false);
  const [customerCreditDialogOpen, setCustomerCreditDialogOpen] = useState(false);
  const [customerCreditAmount, setCustomerCreditAmount] = useState(0);
  const [confirmedLateEdit, setConfirmedLateEdit] = useState(false);
  const [confirmedCustomerCredit, setConfirmedCustomerCredit] = useState(false);

  const reasonRequired = paymentStatus === "paid" || paymentMode === "khata";

  const validItems = useMemo(
    () => items.filter((i) => i.description.trim() && i.unit_price > 0),
    [items],
  );

  const totalAmount = useMemo(
    () => validItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0),
    [validItems],
  );

  const resetForm = useCallback(() => {
    setItems([newBillEditLineItem()]);
    setReason("");
    setReasonError(null);
    setSaving(false);
    setLateEditDialogOpen(false);
    setCustomerCreditDialogOpen(false);
    setCustomerCreditAmount(0);
    setConfirmedLateEdit(false);
    setConfirmedCustomerCredit(false);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        resetForm();
        onClose();
      }
    },
    [onClose, resetForm],
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadingItems(true);
    void fetchBillLineItems(requestId).then((loaded) => {
      if (cancelled) return;
      setItems(loaded);
      setLoadingItems(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, requestId]);

  const updateItem = (id: string, patch: Partial<BillEditLineItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, newBillEditLineItem()]);
  };

  const removeItem = (id: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((i) => i.id !== id)));
  };

  const fetchKhataOutstanding = async (): Promise<number> => {
    const phone = userPhone?.trim();
    if (!phone) return 0;
    const { data, error } = await supabase
      .from("khata_ledger")
      .select("total_outstanding")
      .eq("vendor_id", vendorId)
      .eq("user_phone", phone)
      .maybeSingle();
    if (error) return 0;
    return Number(data?.total_outstanding) || 0;
  };

  const executeSave = async (opts: {
    confirmedLateEdit: boolean;
    confirmedCustomerCredit: boolean;
  }) => {
    if (!validItems.length) return;

    const trimmedReason = reason.trim();
    if (reasonRequired && !trimmedReason) {
      setReasonError(s.bill_editReasonValidation);
      return;
    }

    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }

    setSaving(true);
    setReasonError(null);

    const { data, error } = await supabase.rpc("vendor_edit_bill", {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_new_items: toRpcBillItems(items),
      p_reason: trimmedReason || null,
      p_confirmed_late_edit: opts.confirmedLateEdit,
      p_confirmed_customer_credit: opts.confirmedCustomerCredit,
    });

    if (error) {
      setSaving(false);
      const code = parseBillEditErrorCode(error.message);
      if (code === "late_edit_confirmation_required") {
        setLateEditDialogOpen(true);
        return;
      }
      if (code === "reason_required") {
        setReasonError(s.bill_editReasonValidation);
        return;
      }
      if (code === "would_create_customer_credit") {
        const outstanding = await fetchKhataOutstanding();
        setCustomerCreditAmount(
          computeCustomerCreditAmount(outstanding, originalTotal, totalAmount),
        );
        setCustomerCreditDialogOpen(true);
        return;
      }
      toast.error(s.bill_editFailed);
      return;
    }

    setSaving(false);
    toast.success(s.bill_editSuccess);
    onSuccess(data as VendorEditBillResult);
    resetForm();
    onClose();
  };

  const handleSave = () => {
    void executeSave({
      confirmedLateEdit: confirmedLateEdit,
      confirmedCustomerCredit: confirmedCustomerCredit,
    });
  };

  const confirmLateEdit = () => {
    setConfirmedLateEdit(true);
    setLateEditDialogOpen(false);
    void executeSave({
      confirmedLateEdit: true,
      confirmedCustomerCredit: confirmedCustomerCredit,
    });
  };

  const confirmCustomerCredit = () => {
    setConfirmedCustomerCredit(true);
    setCustomerCreditDialogOpen(false);
    void executeSave({
      confirmedLateEdit: confirmedLateEdit,
      confirmedCustomerCredit: true,
    });
  };

  return (
    <>
      <AlertDialog open={lateEditDialogOpen} onOpenChange={setLateEditDialogOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.bill_editLateTitle}</AlertDialogTitle>
            <AlertDialogDescription>{s.bill_editLateBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                confirmLateEdit();
              }}
            >
              {s.bill_editSave}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={customerCreditDialogOpen} onOpenChange={setCustomerCreditDialogOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.bill_editCreditTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.bill_editCreditBody.replace("{amount}", customerCreditAmount.toFixed(2))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                confirmCustomerCredit();
              }}
            >
              {s.bill_editSave}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={isOpen} onOpenChange={handleOpenChange}>
        <SheetContent
          data-testid="bill-edit-sheet"
          side="bottom"
          className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[90vh] flex flex-col [&>button]:text-muted-foreground"
          style={{
            transform: "translateZ(0)",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <SheetHeader className="sr-only">
              <SheetTitle>{s.bill_editTitle}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pt-2 pr-2">
              <SettingsPageHeader title={s.bill_editTitle} subtitle={shopName} />

              {loadingItems ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
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
                      data-testid="bill-edit-total"
                      className="text-xl font-bold text-brand tabular-nums"
                    >
                      ₹{totalAmount.toFixed(0)}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <label
                      htmlFor="bill-edit-reason"
                      className="text-xs font-semibold text-foreground block"
                    >
                      {reasonRequired ? s.bill_editReasonRequired : s.bill_editReasonOptional}
                    </label>
                    <textarea
                      id="bill-edit-reason"
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        if (reasonError) setReasonError(null);
                      }}
                      placeholder={s.bill_editReasonPlaceholder}
                      rows={2}
                      className={cn(
                        "w-full rounded-xl border bg-surface px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand resize-none",
                        reasonError ? "border-destructive" : "border-surface-border",
                      )}
                    />
                    {reasonError && (
                      <p className="text-xs text-destructive">{reasonError}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    data-testid="bill-edit-save-btn"
                    disabled={saving || validItems.length === 0}
                    onClick={handleSave}
                    className="w-full mt-4 rounded-2xl bg-brand text-white py-4 font-bold active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {saving ? s.incoming_saving : s.bill_editSave}
                  </button>
                </>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
