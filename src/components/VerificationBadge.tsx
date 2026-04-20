import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { isGreenLive, type Vendor } from "@/lib/supabase";

type Tier = "green" | "yellow" | "red";

export function vendorTier(v: Vendor): Tier {
  if (isGreenLive(v)) return "green";
  if (v.verification_status === "identity_linked") return "yellow";
  return "red";
}

const COPY: Record<Tier, { label: string; sub: string }> = {
  green: { label: "Business Verified", sub: "Live photo · GPS · UPI · Admin approved" },
  yellow: { label: "Identity Linked", sub: "Phone & UPI on file" },
  red: { label: "Unverified", sub: "Identity not verified" },
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
  const tier = vendorTier(vendor);
  const Icon =
    tier === "green" ? ShieldCheck : tier === "yellow" ? ShieldAlert : ShieldQuestion;

  const tone =
    tier === "green"
      ? "bg-secondary/15 text-secondary ring-secondary/30"
      : tier === "yellow"
      ? "bg-accent/20 text-accent-foreground ring-accent/40"
      : "bg-destructive/10 text-destructive ring-destructive/30";

  const glow = tier === "green" ? "shadow-[0_0_18px_hsl(var(--secondary)/0.55)]" : "";

  const dims = size === "md" ? "h-6 w-6" : "h-4 w-4";

  if (!showLabel) {
    return (
      <span
        title={COPY[tier].label}
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
        "inline-flex items-center gap-1.5 rounded-full ring-1 px-2.5 py-1 text-xs font-semibold",
        tone,
        glow,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
      {COPY[tier].label}
    </span>
  );
};

export const verificationCopy = COPY;
