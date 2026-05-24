import { ShieldCheck, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Vendor } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";

export type VerificationDisplayTier = "green" | "yellow" | "red";

/**
 * Single source of truth for trust tier UI. Reads only from the vendor row:
 * - Green: admin has manually verified
 * - Yellow: not yet approved, but photo, UPI verified, or legacy `verification_status` Yellow
 * - Red: no manual verification and no submitted identity signals
 */
export function vendorTier(v: Vendor): VerificationDisplayTier {
  if (v.is_manual_verified === true) return "green";
  const statusIsYellow =
    String(v.verification_status ?? "").trim().toLowerCase() === "yellow";
  if (v.shop_photo_url != null || v.upi_verified === true || statusIsYellow) return "yellow";
  return "red";
}

const COPY: Record<
  VerificationDisplayTier,
  { label: string; sub: string }
> = {
  green: {
    label: "Verified Professional",
    sub: "Admin-approved verified business",
  },
  yellow: {
    label: "Identity Submitted",
    sub: "Submitted for review — awaiting admin approval",
  },
  red: {
    label: "Unverified",
    sub: "No verified identity signals on file",
  },
};

export const VerificationBadge = ({
  vendor,
  size = "sm",
  showLabel = false,
  className,
}: {
  vendor: Vendor;
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}) => {
  const { s } = useLanguage();
  const tier = vendorTier(vendor);
  const label =
    tier === "green"
      ? s.vendor_verified_pro
      : tier === "red"
        ? s.settings_unverified
        : COPY[tier].label;
  const Icon = tier === "green" ? ShieldCheck : tier === "yellow" ? Clock : AlertTriangle;

  const tone =
    tier === "green"
      ? "bg-brand/15 text-brand ring-brand/40"
      : tier === "yellow"
        ? "bg-warning/15 text-yellow-600 ring-warning/45"
        : "bg-destructive/10 text-destructive ring-destructive/30";

  const glow = tier === "green" ? "shadow-[0_0_18px_rgba(34,197,94,0.45)]" : "";

  const dims = size === "md" ? "h-6 w-6" : "h-4 w-4";

  if (!showLabel) {
    return (
      <span
        title={`${label} — ${COPY[tier].sub}`}
        className={cn(
          "inline-grid place-items-center rounded-full ring-1 p-1 shrink-0",
          tone,
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
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 font-semibold text-xs leading-snug",
        tone,
        glow,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
      {label}
    </span>
  );
};

export const verificationCopy = COPY;
