import { AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import type { VerificationDisplayTier } from "@/components/VerificationBadge";

export type TrustWarningContext = "radar" | "bridge" | "tracking" | "parchi";

type TrustWarningBannerProps = {
  /** For radar/bridge/parchi: only "green" (hide) vs anything else (unverified warning). Yellow is ignored. */
  tier: VerificationDisplayTier;
  context: TrustWarningContext;
  className?: string;
};

export function TrustWarningBanner({ tier, context, className }: TrustWarningBannerProps) {
  const { s } = useLanguage();

  // Live Tracking privacy banner — leave untouched (page currently unreachable from order flows).
  if (context === "tracking") {
    return (
      <div
        className={cn(
          "mx-4 mb-3 rounded-xl bg-surface border border-brand/40 px-3 py-2.5 flex items-start gap-2 shadow-[0_0_18px_rgba(34,197,94,0.15)]",
          className,
        )}
      >
        <ShieldCheck className="h-4 w-4 text-brand mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-brand leading-tight">
            {s.trust_secure_connection}
          </p>
          <p className="text-[10.5px] text-gray-400 leading-snug">
            {s.trust_banner_masked_privacy}
          </p>
        </div>
      </div>
    );
  }

  if (tier === "green") return null;

  // radar / bridge / parchi: strict binary — yellow retired; any non-green is unverified.
  return (
    <div
      data-testid={`trust-warning-banner-${context}`}
      className={cn(
        "rounded-xl bg-amber-950/40 border border-amber-800/50 px-3 py-2 flex items-start gap-2",
        context === "radar" || context === "parchi" ? "mt-3" : undefined,
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden />
      <p className="min-w-0 flex-1 text-xs text-amber-400 font-semibold leading-relaxed">
        {s.trust_warning_red}
      </p>
    </div>
  );
}
