import { useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, CircleDashed } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  TRUST_TIER_GROUPS,
  computeTrustLevelForBusiness,
  statusForBusinessCheck,
  tierReachedForBusiness,
  type BusinessLocationRow,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";

type StringsShape = ReturnType<typeof useLanguage>["s"];

/**
 * Customer-facing copy for the 7 verification check types, keyed by check_type.
 * Labels reuse the admin checklist keys where the copy is identical.
 */
const TRUST_CHECK_META: Record<
  string,
  { icon: string; labelKey: keyof StringsShape }
> = {
  upi_format: { icon: "💳", labelKey: "admin_check_label_upi_format" },
  photo_shop: { icon: "🏪", labelKey: "admin_check_label_photo_shop" },
  photo_selfie: { icon: "🤳", labelKey: "admin_check_label_photo_selfie" },
  gps: { icon: "📍", labelKey: "trust_check_gps" },
  admin_check: { icon: "✅", labelKey: "trust_check_admin_review" },
  upi_pennydrop: { icon: "🏦", labelKey: "trust_check_upi_pennydrop" },
  aadhaar_digilocker: { icon: "🪪", labelKey: "admin_check_label_aadhaar_digilocker" },
};

export function trustTierLabel(level: TrustLevel, s: StringsShape): string | null {
  switch (level) {
    case "Diamond":
      return s.trust_tier_diamond;
    case "Gold":
      return s.trust_tier_gold;
    case "Silver":
      return s.trust_tier_silver;
    case "Bronze":
      return s.trust_tier_bronze;
    default:
      return null;
  }
}

function CheckStatusChip({
  checkType,
  status,
  s,
}: {
  checkType: string;
  status: string;
  s: StringsShape;
}) {
  if (status === "coming_soon") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0"
        data-testid={`trust-check-coming-soon-${checkType}`}
      >
        <CircleDashed className="h-3.5 w-3.5" />
        {s.trust_check_coming_soon}
      </span>
    );
  }
  if (status === "passed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 dark:text-brand shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {s.trust_status_passed}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-destructive shrink-0">
        <XCircle className="h-3.5 w-3.5" />
        {s.trust_status_failed}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
      <CircleDashed className="h-3.5 w-3.5" />
      {s.trust_status_pending}
    </span>
  );
}

/**
 * Customer-visible trust badge (confirmed product decision):
 * - is_manual_verified false  -> "Unverified"
 * - is_manual_verified true   -> "Verified · [Tier]" (tier from per-business
 *   computeTrustLevelForBusiness; plain "Verified" while loading)
 * Tapping the badge opens a detail sheet listing checks grouped by tier.
 */
export function TrustBadge({
  vendorId,
  categoryId,
  isManualVerified,
  trustLevel,
  showLabel = false,
  size = "sm",
  className,
}: {
  vendorId: string;
  /** Business this badge represents; when omitted, primary-located category is used. */
  categoryId?: string | null;
  isManualVerified: boolean | null | undefined;
  /** Precomputed tier (Radar batch path). When omitted, fetched on mount if verified. */
  trustLevel?: TrustLevel;
  showLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const { s } = useLanguage();
  const verified = isManualVerified === true;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [rows, setRows] = useState<VendorVerificationRow[] | null>(null);
  const [businesses, setBusinesses] = useState<BusinessLocationRow[] | null>(null);
  const [resolvedCategoryId, setResolvedCategoryId] = useState<string | null>(
    categoryId ?? null,
  );

  useEffect(() => {
    setResolvedCategoryId(categoryId ?? null);
  }, [categoryId]);

  const needData =
    (rows === null || businesses === null) &&
    (sheetOpen || (verified && trustLevel === undefined) || categoryId == null);

  useEffect(() => {
    if (!needData) return;
    let cancelled = false;
    void (async () => {
      const [verRes, bizRes] = await Promise.all([
        supabase
          .from("vendor_verification")
          .select("vendor_id, check_type, status, is_latest")
          .eq("vendor_id", vendorId)
          .eq("is_latest", true),
        supabase
          .from("vendor_categories")
          .select(
            "vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status, is_primary, latitude, longitude",
          )
          .eq("vendor_id", vendorId)
          .eq("status", "approved"),
      ]);
      if (cancelled) return;
      if (verRes.error) {
        captureError(verRes.error, { scope: "trustBadge.vendorVerification", vendorId });
        console.error("trustBadge/vendor_verification", verRes.error);
        setRows([]);
      } else {
        setRows((verRes.data ?? []) as VendorVerificationRow[]);
      }
      if (bizRes.error) {
        captureError(bizRes.error, { scope: "trustBadge.vendorCategories", vendorId });
        console.error("trustBadge/vendor_categories", bizRes.error);
        setBusinesses([]);
      } else {
        const list = (bizRes.data ?? []) as Array<
          BusinessLocationRow & { is_primary?: boolean | null; latitude?: number | null }
        >;
        setBusinesses(list);
        if (categoryId == null || categoryId === "") {
          const primary =
            list.find((b) => b.is_primary === true) ??
            list.find((b) => b.latitude != null) ??
            list[0] ??
            null;
          setResolvedCategoryId(primary?.category_id ?? null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needData, vendorId, categoryId]);

  const bizList = businesses ?? [];
  const verList = rows ?? [];
  const level: TrustLevel | undefined =
    trustLevel ??
    (rows !== null && businesses !== null
      ? computeTrustLevelForBusiness(vendorId, resolvedCategoryId, verList, bizList)
      : undefined);
  const tierLabel = verified && level ? trustTierLabel(level, s) : null;
  const label = verified
    ? tierLabel
      ? `${s.badge_verified} · ${tierLabel}`
      : s.badge_verified
    : s.badge_unverified;
  const sub = verified ? s.verification_green_sub : s.verification_red_sub;
  const Icon = verified ? ShieldCheck : AlertTriangle;
  const palette = verified
    ? "bg-brand/15 text-green-700 dark:text-brand ring-brand/40"
    : "bg-amber-950/40 text-amber-400 ring-amber-800/50";
  const glow = verified ? "shadow-[0_0_18px_rgba(34,197,94,0.45)]" : "";
  const dims = size === "md" ? "h-6 w-6" : "h-4 w-4";

  const statusFor = (checkType: string): string =>
    statusForBusinessCheck(checkType, vendorId, resolvedCategoryId, verList, bizList);

  const openSheet = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSheetOpen(true);
  };

  const tierTitle = (tier: (typeof TRUST_TIER_GROUPS)[number]["tier"]): string => {
    switch (tier) {
      case "Bronze":
        return s.trust_tier_bronze;
      case "Silver":
        return s.trust_tier_silver;
      case "Gold":
        return s.trust_tier_gold;
      case "Diamond":
        return s.trust_tier_diamond;
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        title={`${label} — ${sub}`}
        data-testid={verified ? "badge-verified" : "badge-unverified"}
        data-category-id={resolvedCategoryId ?? undefined}
        data-trust-level={level ?? undefined}
        className={cn(
          showLabel
            ? "inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 font-semibold text-xs leading-snug"
            : "inline-grid place-items-center rounded-full ring-1 p-1 shrink-0",
          palette,
          glow,
          className,
        )}
      >
        <Icon className={showLabel ? "h-3.5 w-3.5 shrink-0" : dims} strokeWidth={2.5} />
        {showLabel && label}
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl max-h-[80vh] overflow-y-auto"
          data-testid="trust-detail-sheet"
          data-category-id={resolvedCategoryId ?? undefined}
          onClick={(e) => e.stopPropagation()}
        >
          <SheetHeader className="text-left space-y-1 pr-8">
            <SheetTitle className="font-display">{s.trust_sheet_title}</SheetTitle>
            <SheetDescription>{s.trust_sheet_sub}</SheetDescription>
          </SheetHeader>

          <div className="mt-3">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 font-semibold text-xs leading-snug",
                palette,
                glow,
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
              {label}
            </span>
          </div>

          <div className="mt-4 space-y-4 pb-2">
            {TRUST_TIER_GROUPS.map((group) => {
              const reached =
                rows != null &&
                businesses != null &&
                tierReachedForBusiness(
                  vendorId,
                  resolvedCategoryId,
                  verList,
                  bizList,
                  group.tier,
                );
              return (
                <div
                  key={group.tier}
                  data-testid={`trust-tier-group-${group.tier.toLowerCase()}`}
                  data-tier-reached={reached ? "true" : "false"}
                  className="space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 px-0.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {tierTitle(group.tier)}
                    </p>
                    <span
                      className={cn(
                        "text-[10px] font-semibold",
                        reached
                          ? "text-green-700 dark:text-brand"
                          : "text-muted-foreground",
                      )}
                    >
                      {reached ? s.trust_tier_reached : s.trust_tier_not_reached}
                    </span>
                  </div>
                  {group.checks.map((checkType) => {
                    const meta = TRUST_CHECK_META[checkType];
                    if (!meta) return null;
                    const status = statusFor(checkType);
                    return (
                      <div
                        key={checkType}
                        data-testid={`trust-check-row-${checkType}`}
                        data-check-status={status}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-base shrink-0" aria-hidden>
                            {meta.icon}
                          </span>
                          <span className="text-sm text-foreground">
                            {String(s[meta.labelKey])}
                          </span>
                        </div>
                        <CheckStatusChip checkType={checkType} status={status} s={s} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
