import { useEffect, useState } from "react";
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
import { RadarVendorCard } from "@/components/RadarVendorCard";
import { stampVendorWithBusiness, radarResultKey } from "@/lib/radarBusinessCards";

export type SavedVendorInfo = {
  nickname: string;
  category: string;
};

type NeighbourBusiness = {
  category_id: string;
  label: string;
  emoji: string;
  brand_name: string | null;
  service_mode: string | null;
  serves_at_vendor_place: boolean | null;
  serves_at_customer_place: boolean | null;
  service_radius_km: number | null;
  vendor_note: string | null;
  is_manual_verified: boolean | null;
  shop_photo_url: string | null;
  verification_status: string | null;
  gps_match_distance: number | null;
  location_accuracy: number | null;
  photo_accuracy: number | null;
  latitude: number | null;
  longitude: number | null;
  upi_id: string | null;
  upi_qr_url: string | null;
  upi_qr_payee_id: string | null;
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
  onOpenParchi: _onOpenParchi,
  onOpenAiBridge: _onOpenAiBridge,
  onNavigateOrders,
}: NeighbourSheetProps) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [businesses, setBusinesses] = useState<NeighbourBusiness[]>([]);

  useEffect(() => {
    if (!isOpen) {
      setEditingNickname(false);
      return;
    }
    setNicknameDraft((savedVendor?.nickname ?? "").trim());
  }, [isOpen, savedVendor?.nickname, vendor?.id]);

  useEffect(() => {
    if (!isOpen || !vendor) {
      setBusinesses([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("vendor_categories")
        .select(
          "category_id, brand_name, service_mode, serves_at_vendor_place, serves_at_customer_place, service_radius_km, vendor_note, is_manual_verified, shop_photo_url, verification_status, gps_match_distance, location_accuracy, photo_accuracy, latitude, longitude, upi_id, upi_qr_url, upi_qr_payee_id, categories(label, emoji)",
        )
        .eq("vendor_id", vendor.id)
        .eq("status", "approved");
      if (cancelled) return;
      if (error) {
        captureError(error, { scope: "neighbourSheet.loadBusinesses", vendorId: vendor.id });
        setBusinesses([]);
        return;
      }
      const rows: NeighbourBusiness[] = [];
      for (const row of data ?? []) {
        if (row.verification_status === "pending_location_review") continue;
        if (!row.category_id) continue;
        const joined = row.categories as
          | { label: string; emoji: string }
          | { label: string; emoji: string }[]
          | null;
        const resolved = Array.isArray(joined) ? joined[0] : joined;
        rows.push({
          category_id: row.category_id,
          label: resolved?.label ?? "",
          emoji: resolved?.emoji ?? "✨",
          brand_name: row.brand_name ?? null,
          service_mode: row.service_mode ?? null,
          serves_at_vendor_place: row.serves_at_vendor_place ?? null,
          serves_at_customer_place: row.serves_at_customer_place ?? null,
          service_radius_km: row.service_radius_km ?? null,
          vendor_note: row.vendor_note ?? null,
          is_manual_verified: row.is_manual_verified ?? null,
          shop_photo_url: row.shop_photo_url ?? null,
          verification_status: row.verification_status ?? null,
          gps_match_distance: row.gps_match_distance ?? null,
          location_accuracy: row.location_accuracy ?? null,
          photo_accuracy: row.photo_accuracy ?? null,
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
          upi_id: row.upi_id ?? null,
          upi_qr_url: row.upi_qr_url ?? null,
          upi_qr_payee_id: row.upi_qr_payee_id ?? null,
        });
      }
      setBusinesses(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, vendor?.id]);

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

            <div className="mt-6 flex flex-col gap-3">
              {(activeDeliveryOrder || activeAppointmentOrder) && (
                <button
                  type="button"
                  className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                  onClick={() => {
                    onClose();
                    onNavigateOrders();
                  }}
                >
                  {activeAppointmentOrder ? s.yourActiveBookings : s.yourActiveOrders}
                </button>
              )}
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.neighbours_businesses_heading}
              </p>
              {businesses.map((biz) => {
                const stamped = stampVendorWithBusiness(
                  vendor as unknown as Record<string, unknown>,
                  biz,
                );
                const cardVendor = {
                  ...(stamped as unknown as Vendor),
                  service_mode: (biz.service_mode ?? vendor.service_mode) as Vendor["service_mode"],
                };
                return (
                  <div
                    key={radarResultKey(vendor.id, biz.category_id)}
                    data-testid="neighbour-business-card"
                    data-category-id={biz.category_id}
                  >
                    <RadarVendorCard
                      vendor={cardVendor}
                      radarServiceMode={biz.service_mode ?? vendor.service_mode ?? undefined}
                      dist={null}
                      index={0}
                      userNeed={biz.label}
                      categories={[
                        {
                          label: biz.label,
                          emoji: biz.emoji,
                          category_id: biz.category_id,
                          brand_name: biz.brand_name,
                          serves_at_vendor_place: biz.serves_at_vendor_place,
                          serves_at_customer_place: biz.serves_at_customer_place,
                          service_radius_km: biz.service_radius_km,
                          is_manual_verified: biz.is_manual_verified,
                          shop_photo_url: biz.shop_photo_url,
                          verification_status: biz.verification_status,
                          gps_match_distance: biz.gps_match_distance,
                          location_accuracy: biz.location_accuracy,
                          photo_accuracy: biz.photo_accuracy,
                          latitude: biz.latitude,
                          longitude: biz.longitude,
                          upi_id: biz.upi_id,
                          upi_qr_url: biz.upi_qr_url,
                          upi_qr_payee_id: biz.upi_qr_payee_id,
                        },
                      ]}
                      menuItems={[]}
                      isSaved
                      hasOrdered={false}
                      hasFulfilledOrder={false}
                      displayBrandName={biz.brand_name ?? undefined}
                    />
                  </div>
                );
              })}
              <button
                type="button"
                className="w-full rounded-xl border border-border h-10 text-sm font-semibold text-muted-foreground"
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
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
