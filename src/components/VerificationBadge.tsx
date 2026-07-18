import { ShieldCheck, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Vendor } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { strings } from "@/lib/strings";
import {
  businessBadgeTone,
  type AccountTrustSignals,
  type BusinessTrustSignals,
} from "@/lib/businessTrust";

export type VerificationDisplayTier = "green" | "yellow" | "red";

type VerificationStrings = typeof strings.en;

/**
 * Legacy account-level tier (admin lists / older call sites).
 * Customer-facing Radar/order badges should use BusinessVerificationBadge.
 */
export function vendorTier(v: Vendor): VerificationDisplayTier {
  if (v.is_manual_verified === true) return "green";
  const statusIsYellow =
    String(v.verification_status ?? "").trim().toLowerCase() === "yellow";
  if (v.shop_photo_url != null || v.upi_verified === true || statusIsYellow) return "yellow";
  return "red";
}

export function getVerificationCopy(s: VerificationStrings): Record<
  VerificationDisplayTier,
  { label: string; sub: string }
> {
  return {
    green: {
      label: s.vendor_verified_pro,
      sub: s.verification_green_sub,
    },
    yellow: {
      label: s.verification_yellow_label,
      sub: s.verification_yellow_sub,
    },
    red: {
      label: s.settings_unverified,
      sub: s.verification_red_sub,
    },
  };
}

/** Binary per-business badge for customers (Verified | Unverified only). */
export function BusinessVerificationBadge({
  account,
  business,
  size = "sm",
  showLabel = false,
  className,
}: {
  account: AccountTrustSignals;
  business: BusinessTrustSignals | null | undefined;
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}) {
  const { s } = useLanguage();
  const tone = businessBadgeTone(account, business);
  const verified = tone === "verified";
  const label = verified ? s.badge_verified : s.badge_unverified;
  const sub = verified ? s.verification_green_sub : s.verification_red_sub;
  const Icon = verified ? ShieldCheck : AlertTriangle;
  const palette = verified
    ? "bg-brand/15 text-green-700 dark:text-brand ring-brand/40"
    : "bg-amber-950/40 text-amber-400 ring-amber-800/50";
  const glow = verified ? "shadow-[0_0_18px_rgba(34,197,94,0.45)]" : "";
  const dims = size === "md" ? "h-6 w-6" : "h-4 w-4";

  if (!showLabel) {
    return (
      <span
        title={`${label} — ${sub}`}
        data-testid={verified ? "badge-verified" : "badge-unverified"}
        className={cn(
          "inline-grid place-items-center rounded-full ring-1 p-1 shrink-0",
          palette,
          glow,
          className,
        )}
      >
        <Icon className={dims} strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span
      data-testid={verified ? "badge-verified" : "badge-unverified"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 font-semibold text-xs leading-snug",
        palette,
        glow,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
      {label}
    </span>
  );
}

/** @deprecated Use getVerificationCopy(s) with useLanguage() instead. */
export const verificationCopy = getVerificationCopy(strings.en);
