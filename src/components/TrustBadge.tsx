import { useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, CircleDashed } from "lucide-react";
import { supabase } from "@/lib/supabase";
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
  computeTrustLevel,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";

type StringsShape = ReturnType<typeof useLanguage>["s"];

/**
 * Customer-facing copy for the 7 verification check types, in tier
 * progression order (Bronze checks first, then Silver/Gold/Diamond).
 * Labels reuse the admin checklist keys where the copy is identical.
 */
const TRUST_CHECKS: { check_type: string; icon: string; labelKey: keyof StringsShape }[] = [
  { check_type: "photo_shop", icon: "🏪", labelKey: "admin_check_label_photo_shop" },
  { check_type: "photo_selfie", icon: "🤳", labelKey: "admin_check_label_photo_selfie" },
  { check_type: "gps", icon: "📍", labelKey: "trust_check_gps" },
  { check_type: "upi_format", icon: "💳", labelKey: "admin_check_label_upi_format" },
  { check_type: "admin_check", icon: "✅", labelKey: "trust_check_admin_review" },
  { check_type: "upi_pennydrop", icon: "🏦", labelKey: "trust_check_upi_pennydrop" },
  { check_type: "aadhaar_digilocker", icon: "🪪", labelKey: "admin_check_label_aadhaar_digilocker" },
];

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

function CheckStatusChip({ status, s }: { status: string; s: StringsShape }) {
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
 * - is_manual_verified true   -> "Verified · [Tier]" (tier from trustLevel.ts;
 *   plain "Verified" while tier data is loading or when no checks passed yet)
 * Tapping the badge opens a detail sheet listing all 7 verification checks
 * with pass/fail/pending state.
 */
export function TrustBadge({
  vendorId,
  isManualVerified,
  trustLevel,
  showLabel = false,
  size = "sm",
  className,
}: {
  vendorId: string;
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

  // Per-check statuses are needed once the sheet opens; the tier itself is
  // also needed when the parent didn't precompute it (non-Radar surfaces).
  const needRows = rows === null && (sheetOpen || (verified && trustLevel === undefined));

  useEffect(() => {
    if (!needRows) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("vendor_verification")
        .select("vendor_id, check_type, status, is_latest")
        .eq("vendor_id", vendorId)
        .eq("is_latest", true);
      if (cancelled) return;
      if (error) {
        // Degrade: badge stays "Verified"/"Unverified", sheet shows pending.
        console.error("trustBadge/vendor_verification", error);
        setRows([]);
        return;
      }
      setRows((data ?? []) as VendorVerificationRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [needRows, vendorId]);

  const level: TrustLevel | undefined =
    trustLevel ?? (rows !== null ? computeTrustLevel(vendorId, rows) : undefined);
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

  const statusFor = (checkType: string): string => {
    const row = rows?.find((r) => r.check_type === checkType && r.is_latest !== false);
    const raw = row?.status ?? "pending";
    return raw === "passed" || raw === "failed" ? raw : "pending";
  };

  const openSheet = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSheetOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        title={`${label} — ${sub}`}
        data-testid={verified ? "badge-verified" : "badge-unverified"}
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

          <div className="mt-4 space-y-2 pb-2">
            {TRUST_CHECKS.map((check) => {
              const status = statusFor(check.check_type);
              return (
                <div
                  key={check.check_type}
                  data-testid={`trust-check-row-${check.check_type}`}
                  data-check-status={status}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base shrink-0" aria-hidden>
                      {check.icon}
                    </span>
                    <span className="text-sm text-foreground">{String(s[check.labelKey])}</span>
                  </div>
                  <CheckStatusChip status={status} s={s} />
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
