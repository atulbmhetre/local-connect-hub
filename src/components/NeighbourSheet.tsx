import { useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  emojiForVendorCategory,
  supabase,
  type Category,
  type Vendor,
  useCategoryLabel,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
import { savedNeighbourDisplayName, markNeighboursDirty } from "@/lib/savedVendors";
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

export type SavedVendorInfo = {
  nickname: string;
  category: string;
};

type NeighbourSheetProps = {
  vendor: Vendor | null;
  savedVendor: SavedVendorInfo | null;
  isOpen: boolean;
  onClose: () => void;
  onRemove: () => void;
  /** Called after nickname set/clear so Home tiles can refresh. */
  onNicknameChanged?: (nickname: string) => void;
  activeDeliveryOrder: boolean;
  activeAppointmentOrder: boolean;
  categories: Category[];
  onOpenParchi: (vendor: Vendor) => void;
  onOpenAiBridge: (vendor: Vendor) => void;
  onNavigateOrders: () => void;
};

export function NeighbourSheet({
  vendor,
  savedVendor,
  isOpen,
  onClose,
  onRemove,
  onNicknameChanged,
  activeDeliveryOrder,
  activeAppointmentOrder,
  categories,
  onOpenParchi,
  onOpenAiBridge,
  onNavigateOrders,
}: NeighbourSheetProps) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameBusy, setNicknameBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setEditingNickname(false);
      return;
    }
    setNicknameDraft((savedVendor?.nickname ?? "").trim());
  }, [isOpen, savedVendor?.nickname, vendor?.id]);

  const displayName = savedNeighbourDisplayName(
    savedVendor?.nickname,
    vendor?.shop_name,
  );
  const categoryLabel = getLabel(vendor?.category ?? savedVendor?.category ?? "") ||
    vendor?.category ||
    "";

  const handleRemove = async () => {
    if (!vendor) return;
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("unsave_saved_vendor", {
              p_vendor_id: vendor.id,
              p_device_id: device_id,
              p_user_phone: userPhone ?? null,
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
          scope: "neighbourSheet.unsaveSavedVendor",
          vendorId: vendor.id,
        });
        toast.error(s.couldNotRemove, { description: error.message });
        return;
      }
      try {
        sessionStorage.removeItem(`aaspaas:saved:${vendor.id}`);
      } catch {
        /* ignore */
      }
      markNeighboursDirty();
      onClose();
      onRemove();
      toast.success(s.removedFromNeighbourhood);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        captureError(err, {
          scope: "neighbourSheet.unsaveSavedVendor",
          vendorId: vendor.id,
        });
        showNetworkFailedToast(() => void handleRemove(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const persistNickname = async (next: string) => {
    if (!vendor || nicknameBusy) return;
    setNicknameBusy(true);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("update_saved_vendor_nickname", {
              p_vendor_id: vendor.id,
              p_nickname: next,
              p_device_id: device_id,
              p_user_phone: userPhone ?? null,
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
          scope: "neighbourSheet.updateNickname",
          vendorId: vendor.id,
        });
        toast.error(s.neighbours_nickname_could_not_update, {
          description: error.message,
        });
        return;
      }
      markNeighboursDirty();
      setEditingNickname(false);
      onNicknameChanged?.(next.trim());
      toast.success(
        next.trim() ? s.neighbours_nickname_updated : s.neighbours_nickname_cleared,
      );
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        captureError(err, {
          scope: "neighbourSheet.updateNickname",
          vendorId: vendor.id,
        });
        showNetworkFailedToast(() => void persistNickname(next), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setNicknameBusy(false);
    }
  };

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl max-h-[85vh] overflow-y-auto"
      >
        {vendor && (
          <>
            <SheetHeader className="text-left space-y-3 pr-8">
              <div className="flex items-start gap-3">
                <div className="relative shrink-0">
                  <span
                    className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                      vendor.is_active ? "bg-brand" : "bg-muted-foreground/50"
                    }`}
                    aria-hidden
                  />
                  <div className="h-12 w-12 rounded-xl overflow-hidden bg-muted grid place-items-center">
                    {vendor.shop_photo_url ? (
                      <img src={vendor.shop_photo_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-2xl" aria-hidden>
                        {emojiForVendorCategory(vendor.category, categories)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <SheetTitle className="text-left font-display text-lg">
                    {displayName}
                  </SheetTitle>
                  {(savedVendor?.nickname ?? "").trim() &&
                    (savedVendor?.nickname ?? "").trim() !==
                      (vendor.shop_name ?? "").trim() && (
                      <p className="text-xs text-muted-foreground truncate">
                        {vendor.shop_name}
                      </p>
                    )}
                  <p className="text-sm text-muted-foreground">{categoryLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {vendor.is_active ? (
                      <span className="text-brand font-medium">{s.online}</span>
                    ) : (
                      <span>{s.offline}</span>
                    )}
                  </p>
                </div>
              </div>
              <SheetDescription className="sr-only">
                {s.home_saved_vendor_sheet_description}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-2">
              {editingNickname ? (
                <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
                  <label className="text-xs font-medium text-muted-foreground">
                    {s.neighbours_nickname_label}
                  </label>
                  <input
                    data-testid="neighbour-nickname-input"
                    type="text"
                    value={nicknameDraft}
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    placeholder={s.neighbours_nickname_placeholder}
                    maxLength={40}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="neighbour-nickname-save-btn"
                      disabled={nicknameBusy}
                      className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-[#0b1f14] disabled:opacity-60"
                      onClick={() => void persistNickname(nicknameDraft)}
                    >
                      {s.neighbours_nickname_apply}
                    </button>
                    <button
                      type="button"
                      data-testid="neighbour-nickname-clear-btn"
                      disabled={nicknameBusy}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground disabled:opacity-60"
                      onClick={() => void persistNickname("")}
                    >
                      {s.neighbours_nickname_clear}
                    </button>
                    <button
                      type="button"
                      disabled={nicknameBusy}
                      className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
                      onClick={() => {
                        setEditingNickname(false);
                        setNicknameDraft((savedVendor?.nickname ?? "").trim());
                      }}
                    >
                      {s.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="neighbour-nickname-edit-btn"
                  className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                  onClick={() => setEditingNickname(true)}
                >
                  {s.neighbours_nickname_edit}
                </button>
              )}
            </div>

            <div className="mt-6 flex flex-col gap-2">
              {String(vendor.service_mode ?? "")
                .trim()
                .toLowerCase() === "delivery" ? (
                activeDeliveryOrder ? (
                  <>
                    <button
                      type="button"
                      className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                      onClick={() => {
                        onClose();
                        onNavigateOrders();
                      }}
                    >
                      {s.yourActiveOrders}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                      onClick={() => {
                        onClose();
                        onOpenParchi(vendor);
                      }}
                    >
                      {s.sendNewOrder}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                    onClick={() => {
                      onClose();
                      onOpenParchi(vendor);
                    }}
                  >
                    {s.sendOrder}
                  </button>
                )
              ) : String(vendor.service_mode ?? "")
                  .trim()
                  .toLowerCase() === "appointment" ? (
                <>
                  {activeAppointmentOrder ? (
                    <>
                      <button
                        type="button"
                        className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                        onClick={() => {
                          onClose();
                          onNavigateOrders();
                        }}
                      >
                        {s.yourActiveBookings}
                      </button>
                      <button
                        type="button"
                        className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                        onClick={() => {
                          onClose();
                          onOpenParchi(vendor);
                        }}
                      >
                        {s.bookAgain}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                      onClick={() => {
                        onClose();
                        onOpenParchi(vendor);
                      }}
                    >
                      {s.bookService}
                    </button>
                  )}
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                    onClick={onClose}
                  >
                    {s.cancel}
                  </button>
                  <button
                    type="button"
                    className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                    onClick={() => void handleRemove()}
                  >
                    {s.removeFromNeighbourhood}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98]"
                  onClick={() => {
                    onClose();
                    onOpenAiBridge(vendor);
                  }}
                >
                  <Phone className="h-4 w-4" />
                  {s.connectAiBridge}
                </button>
              )}
              {String(vendor.service_mode ?? "")
                .trim()
                .toLowerCase() !== "appointment" && (
                <>
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                    onClick={onClose}
                  >
                    {s.cancel}
                  </button>
                  <button
                    type="button"
                    className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                    onClick={() => void handleRemove()}
                  >
                    {s.removeFromNeighbourhood}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
