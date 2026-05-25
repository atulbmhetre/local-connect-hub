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
  VerificationBadge,
  vendorTier,
  verificationCopy,
} from "@/components/VerificationBadge";
import {
  emojiForVendorCategory,
  fetchAiBridgeBrief,
  invokeInitiateCall,
  useCategoryLabel,
  type Vendor,
} from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";

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
};

type AiBridgeSheetProps = {
  open: boolean;
  onClose: () => void;
  vendor: AiBridgeVendor;
  callerPhone: string;
  /** Search need / category context for the AI brief. */
  userNeed?: string;
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
    latitude: null,
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
  };
}

export function AiBridgeSheet({
  open,
  onClose,
  vendor,
  callerPhone,
  userNeed,
  distanceKm = null,
  onCallSuccess,
}: AiBridgeSheetProps) {
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getLabel = useCategoryLabel();
  const vendorRow = useMemo(() => asVendor(vendor), [vendor]);
  const tier = vendorTier(vendorRow);

  const [briefLoading, setBriefLoading] = useState(false);
  const [briefText, setBriefText] = useState<string | null>(null);
  const [briefFailed, setBriefFailed] = useState(false);
  const [callLoading, setCallLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);

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

    const result = await fetchAiBridgeBrief({
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
      setCallLoading(false);
      setConnecting(false);
      return;
    }
    void loadBrief();
  }, [open, loadBrief]);

  useEffect(() => {
    if (!connecting) return;
    const t = window.setTimeout(() => {
      setConnecting(false);
      onClose();
    }, 3000);
    return () => window.clearTimeout(t);
  }, [connecting, onClose]);

  const handleCallNow = async () => {
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

    setCallLoading(true);
    const result = await invokeInitiateCall({
      caller_phone: caller,
      vendor_phone: vendorPhone,
      service_mode: vendor.service_mode ?? "help",
    });
    setCallLoading(false);

    if (!result.success) {
      toast.error(s.ai_bridge_call_failed);
      return;
    }

    onCallSuccess?.(vendor.id);
    setConnecting(true);
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="bottom"
        className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl max-h-[85vh] overflow-y-auto"
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
              <VerificationBadge vendor={vendorRow} showLabel />
              <span className="text-[10px] text-gray-500">
                {verificationCopy[tier].label}
              </span>
            </div>
          </div>

          {vendor.vendor_note?.trim() && (
            <div className="rounded-xl border border-brand-border bg-brand/5 px-3 py-2 text-[11px] text-green-700 dark:text-brand">
              📌 {vendor.vendor_note}
            </div>
          )}

          {(vendor.total_helped != null && vendor.total_helped > 0) ||
          (vendor.on_time_rate != null && Number.isFinite(vendor.on_time_rate)) ? (
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-400">
              {vendor.total_helped != null && vendor.total_helped > 0 && (
                <span>
                  {s.radar_helped}
                  <span className="font-semibold text-brand tabular-nums">
                    {vendor.total_helped}
                  </span>{" "}
                  {vendor.total_helped === 1 ? s.radar_person : s.radar_people}
                </span>
              )}
              {vendor.on_time_rate != null && Number.isFinite(vendor.on_time_rate) && (
                <span>
                  <span className="font-semibold text-brand tabular-nums">
                    {Math.round(vendor.on_time_rate)}
                  </span>
                  {s.radar_on_time}
                </span>
              )}
            </div>
          ) : null}

          <p className="text-[11px] text-amber-400/90 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
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

          {connecting ? (
            <p className="text-sm text-brand text-center py-3">{s.ai_bridge_connecting}</p>
          ) : (
            <button
              type="button"
              disabled={briefLoading || callLoading}
              onClick={() => void handleCallNow()}
              className="w-full rounded-xl bg-brand text-page-bg py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
            >
              {callLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                s.ai_bridge_call_now
              )}
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
