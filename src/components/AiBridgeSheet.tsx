import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
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
import { TrustBadge } from "@/components/TrustBadge";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";
import { deriveBusinessLocationPasses, findBusinessLocationRow, type BusinessLocationRow } from "@/lib/trustLevel";
import { resolveCategoryVendorNote } from "@/lib/categoryScopedVendor";
import {
  emojiForVendorCategory,
  buildVendorBrief,
  invokeInitiateCall,
  useCategoryLabel,
  supabase,
  type Vendor,
} from "@/lib/supabase";
import { mapPublicCategoryOrderStats } from "@/lib/categoryScopedVendor";
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { SecureCallPreDialOverlay } from "@/components/SecureCallPreDialOverlay";

export type AiBridgeVendor = Pick<
  Vendor,
  | "id"
  | "name"
  | "shop_name"
  | "category"
  | "vendor_note"
  | "phone"
  | "service_mode"
  | "verification_status"
  | "is_manual_verified"
  | "total_helped"
  | "on_time_rate"
> & {
  shop_photo_url?: string | null;
  upi_verified?: boolean;
  photo_selfie?: string | null;
  latitude?: number | null;
};

type AiBridgeSheetProps = {
  open: boolean;
  onClose: () => void;
  vendor: AiBridgeVendor;
  callerPhone: string;
  /** Search need / category context for the AI brief. */
  userNeed?: string;
  /** Prefer order/search matched category; TrustBadge falls back to primary. */
  categoryId?: string | null;
  distanceKm?: number | null;
  onCallSuccess?: (vendorId: string) => void;
};

function asVendor(v: AiBridgeVendor): Vendor {
  return {
    id: v.id,
    name: v.name,
    shop_name: v.shop_name,
    category: v.category,
    upi_id: "",
    phone: v.phone,
    is_active: true,
    latitude: v.latitude ?? null,
    longitude: null,
    verification_status: v.verification_status,
    shop_photo_url: v.shop_photo_url ?? null,
    upi_verified: v.upi_verified ?? false,
    is_manual_verified: v.is_manual_verified,
    created_at: "",
    service_mode: v.service_mode,
    vendor_note: v.vendor_note,
    cancel_reason_1: null,
    cancel_reason_2: null,
    cancel_reason_3: null,
    cancel_reason_4: null,
    total_helped: v.total_helped,
    on_time_rate: v.on_time_rate,
    service_radius_km: 15,
    photo_selfie: v.photo_selfie ?? null,
  };
}

export function AiBridgeSheet({
  open,
  onClose,
  vendor,
  callerPhone,
  userNeed,
  categoryId,
  distanceKm = null,
  onCallSuccess,
}: AiBridgeSheetProps) {
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getLabel = useCategoryLabel();
  const [businessGpsVerified, setBusinessGpsVerified] = useState<boolean | null>(null);
  
  const vendorRow = useMemo(() => asVendor(vendor), [vendor]);
  const bannerTier = vendorBinaryTrustTier({
    ...vendorRow,
    businessGpsVerified: businessGpsVerified ?? undefined,
  });
  const secureCallingLive = config.exotelSecureCallingEnabled;
  const vendorDisplayName = vendor.name?.trim() || vendor.shop_name || "vendor";
  
  // Fetch business-specific GPS verification when categoryId is available
  useEffect(() => {
    if (!categoryId || !vendor.id) {
      setBusinessGpsVerified(null);
      setCategoryVendorNote(null);
      return;
    }

    const fetchBusinessGps = async () => {
      try {
        const { data, error } = await supabase
          .from("vendor_categories")
          .select("gps_match_distance, location_accuracy, photo_accuracy, verification_status, vendor_note")
          .eq("vendor_id", vendor.id)
          .eq("category_id", categoryId)
          .single();

        if (error || !data) {
          setBusinessGpsVerified(null);
          setCategoryVendorNote(null);
          return;
        }

        setCategoryVendorNote(String(data.vendor_note ?? "").trim() || null);

        const businessLocationData: BusinessLocationRow = {
          vendor_id: vendor.id,
          category_id: categoryId,
          gps_match_distance: data.gps_match_distance,
          location_accuracy: data.location_accuracy,
          photo_accuracy: data.photo_accuracy,
          verification_status: data.verification_status,
        };

        const { gps } = deriveBusinessLocationPasses(businessLocationData);
        setBusinessGpsVerified(gps);
      } catch (err) {
        console.error("Failed to fetch business GPS data:", err);
        setBusinessGpsVerified(null);
      }
    };

    void fetchBusinessGps();
  }, [categoryId, vendor.id]);

  const [briefLoading, setBriefLoading] = useState(false);
  const [briefText, setBriefText] = useState<string | null>(null);
  const [briefFailed, setBriefFailed] = useState(false);
  const [callPhase, setCallPhase] = useState<"idle" | "predial" | "ringing">("idle");
  const [directCallConfirmOpen, setDirectCallConfirmOpen] = useState(false);
  const [categoryVendorNote, setCategoryVendorNote] = useState<string | null>(null);
  const [categoryFulfilled, setCategoryFulfilled] = useState<number | null>(null);
  const [categoryOnTimeRate, setCategoryOnTimeRate] = useState<number | null>(null);

  const limitMinutes = (() => {
    switch ((vendor.service_mode ?? "").toLowerCase()) {
      case "help":
        return Math.round(config.helpCallLimitSeconds / 60);
      case "delivery":
        return Math.round(config.deliveryCallLimitSeconds / 60);
      case "appointment":
        return Math.round(config.appointmentCallLimitSeconds / 60);
      default:
        return Math.round(config.appointmentCallLimitSeconds / 60);
    }
  })();
  const callLimitedLabel = s.ai_bridge_call_limited.replace("X", String(limitMinutes));
  const categoryEmoji = emojiForVendorCategory(vendor.category);
  const categoryLabel = getLabel(vendor.category);

  const loadBrief = useCallback(async () => {
    const need = (userNeed ?? "").trim() || vendor.category || "help";
    setBriefLoading(true);
    setBriefFailed(false);
    setBriefText(null);

    const result = await buildVendorBrief({
      vendor_name: vendor.name?.trim() ? vendor.name : vendor.shop_name,
      shop_name: vendor.shop_name,
      category: vendor.category,
      distance_km: distanceKm,
      user_need: need,
    });

    setBriefLoading(false);
    if (result.ok) {
      setBriefText(result.brief);
      setBriefFailed(false);
    } else {
      setBriefText(null);
      setBriefFailed(true);
    }
  }, [
    distanceKm,
    userNeed,
    vendor.category,
    vendor.name,
    vendor.shop_name,
  ]);

  useEffect(() => {
    if (!open) {
      setBriefLoading(false);
      setBriefText(null);
      setBriefFailed(false);
      setCallPhase("idle");
      setDirectCallConfirmOpen(false);
      setCategoryFulfilled(null);
      setCategoryOnTimeRate(null);
      return;
    }
    void loadBrief();
  }, [open, loadBrief]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      let resolvedCategoryId = categoryId?.trim() || null;
      if (!resolvedCategoryId) {
        const { data: cats } = await supabase
          .from("vendor_categories")
          .select("category_id, is_primary, latitude")
          .eq("vendor_id", vendor.id)
          .eq("status", "approved");
        if (cancelled) return;
        const list = cats ?? [];
        const primary =
          list.find((c) => c.is_primary === true) ??
          list.find((c) => c.latitude != null) ??
          list[0] ??
          null;
        resolvedCategoryId = primary?.category_id ?? null;
      }
      if (!resolvedCategoryId) {
        if (!cancelled) {
          setCategoryFulfilled(0);
          setCategoryOnTimeRate(null);
        }
        return;
      }
      const { data, error } = await supabase.rpc("get_public_vendor_category_order_stats", {
        p_vendor_ids: [vendor.id],
        p_category_ids: [resolvedCategoryId],
      });
      if (cancelled) return;
      if (error) {
        console.error("aiBridge/category_order_stats", error);
        setCategoryFulfilled(0);
        setCategoryOnTimeRate(null);
        return;
      }
      const map = mapPublicCategoryOrderStats(data ?? []);
      const rep = map.get(`${vendor.id}:${resolvedCategoryId}`);
      setCategoryFulfilled(rep?.fulfilled ?? 0);
      setCategoryOnTimeRate(rep?.onTimeRate ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, categoryId, vendor.id]);

  useEffect(() => {
    if (callPhase !== "ringing") return;
    const t = window.setTimeout(() => {
      setCallPhase("idle");
      onClose();
    }, 3000);
    return () => window.clearTimeout(t);
  }, [callPhase, onClose]);

  const openDirectTel = () => {
    const vendorPhone = vendor.phone.replace(/[\s\-+]/g, "").trim();
    if (!vendorPhone) {
      toast.error(s.ai_bridge_call_failed);
      return;
    }
    window.open(`tel:${vendorPhone}`, "_self");
  };

  const handleCallNow = async () => {
    if (!secureCallingLive) {
      toast(s.secure_call_coming_soon);
      return;
    }

    const caller = callerPhone.replace(/[\s\-+]/g, "").trim();
    const vendorPhone = vendor.phone.replace(/[\s\-+]/g, "").trim();
    if (!caller) {
      toast.error(s.ai_bridge_call_failed);
      return;
    }
    if (!vendorPhone) {
      toast.error(s.ai_bridge_call_failed);
      return;
    }

    setCallPhase("predial");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const result = await invokeInitiateCall({
      caller_phone: caller,
      vendor_phone: vendorPhone,
      service_mode: vendor.service_mode ?? "help",
    });

    if (!result.success) {
      setCallPhase("idle");
      setDirectCallConfirmOpen(true);
      return;
    }

    onCallSuccess?.(vendor.id);
    setCallPhase("ringing");
  };

  const displayVendorNote = resolveCategoryVendorNote(
    categoryVendorNote,
    vendor.vendor_note,
    categoryId,
  );

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="bottom"
        className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl max-h-[85vh] overflow-y-auto px-4"
      >
        <SheetHeader className="text-left space-y-1 pr-8">
          <SheetTitle className="text-white font-display">{s.aiBridge}</SheetTitle>
          <SheetDescription className="text-gray-400">
            {briefLoading
              ? s.briefingVendor
              : briefFailed
                ? s.aiBriefUnavailable
                : s.yourCallBrief}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="space-y-1">
            <p className="font-display font-bold text-lg leading-tight">{vendor.name}</p>
            <p className="text-sm text-gray-400">{vendor.shop_name}</p>
            <p className="text-sm text-gray-300">
              {categoryEmoji} {categoryLabel}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <TrustBadge
                vendorId={vendorRow.id}
                categoryId={categoryId}
                isManualVerified={vendorRow.is_manual_verified}
                showLabel
              />
            </div>
          </div>

          <TrustWarningBanner tier={bannerTier} context="bridge" />

          {displayVendorNote && (
            <div className="rounded-xl border border-brand-border bg-brand/5 px-3 py-2 text-xs text-green-700 dark:text-brand">
              📌 {displayVendorNote}
            </div>
          )}

          {(categoryFulfilled != null && categoryFulfilled > 0) ||
          (categoryOnTimeRate != null && Number.isFinite(categoryOnTimeRate)) ? (
            <div className="flex flex-wrap gap-3 text-xs text-gray-400">
              {categoryFulfilled != null && categoryFulfilled > 0 && (
                <span>
                  {s.radar_helped}
                  <span className="font-semibold text-brand tabular-nums">
                    {categoryFulfilled}
                  </span>{" "}
                  {categoryFulfilled === 1 ? s.radar_person : s.radar_people}
                </span>
              )}
              {categoryOnTimeRate != null && Number.isFinite(categoryOnTimeRate) && (
                <span>
                  <span className="font-semibold text-brand tabular-nums">
                    {Math.round(categoryOnTimeRate)}
                  </span>
                  {s.radar_on_time}
                </span>
              )}
            </div>
          ) : null}

          <p className="text-xs text-amber-400/90 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            {callLimitedLabel}
          </p>

          {briefLoading && (
            <div className="flex items-center gap-3 py-4 text-gray-300">
              <Loader2 className="h-6 w-6 animate-spin text-brand shrink-0" />
              <p className="text-sm">{s.briefingVendor}</p>
            </div>
          )}

          {!briefLoading && briefFailed && (
            <p className="text-sm text-amber-200/90 leading-relaxed">{s.aiBriefUnavailable}</p>
          )}

          {!briefLoading && !briefFailed && briefText && (
            <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
              {briefText}
            </p>
          )}

          {callPhase === "idle" ? (
            <button
              type="button"
              disabled={briefLoading || !secureCallingLive}
              onClick={() => void handleCallNow()}
              className="w-full rounded-xl bg-brand text-page-bg h-12 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
            >
              {!secureCallingLive ? s.secure_call_coming_soon : s.ai_bridge_call_now}
            </button>
          ) : (
            <p className="text-sm text-brand text-center py-3">{s.secure_call_predial_title}</p>
          )}
        </div>
      </SheetContent>

      {callPhase !== "idle" && (
        <SecureCallPreDialOverlay phase={callPhase === "ringing" ? "ringing" : "predial"} />
      )}

      <AlertDialog open={directCallConfirmOpen} onOpenChange={setDirectCallConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.secure_call_failed_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.secure_call_failed_body_bridge.replace("{name}", vendorDisplayName)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDirectCallConfirmOpen(false);
                openDirectTel();
              }}
            >
              {s.secure_call_call_directly}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
