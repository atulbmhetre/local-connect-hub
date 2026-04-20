import { Phone, Store, MapPin, AlertTriangle } from "lucide-react";
import type { Vendor } from "@/lib/supabase";
import { toast } from "sonner";
import { VerificationBadge, vendorTier } from "@/components/VerificationBadge";

type Props = { vendor: Vendor; distanceKm?: number | null };

export const VendorCard = ({ vendor, distanceKm }: Props) => {
  const tier = vendorTier(vendor);
  const handleCall = () => {
    toast("AI-Bridge Call", {
      description: `Connecting you to ${vendor.name} (${vendor.shop_name}). Live bridging coming soon.`,
    });
  };
  return (
    <div className="rounded-2xl bg-card border border-border shadow-card p-4 animate-fade-up">
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-gradient-vendor grid place-items-center shrink-0 overflow-hidden">
          {vendor.shop_photo_url ? (
            <img
              src={vendor.shop_photo_url}
              alt={`${vendor.shop_name} shop`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Store className="h-6 w-6 text-secondary-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="font-display font-bold truncate">{vendor.shop_name}</h3>
            <VerificationBadge vendor={vendor} />
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {vendor.name} · {vendor.category}
          </p>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>UPI: {vendor.upi_id}</span>
            {typeof distanceKm === "number" && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`}
              </span>
            )}
          </div>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-full bg-secondary/15 text-secondary">
          Live
        </span>
      </div>

      {tier === "red" && (
        <div className="mt-3 rounded-xl bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-xs text-destructive font-semibold">
            Warning: Identity Not Verified — connect at your own risk.
          </p>
        </div>
      )}

      <button
        onClick={handleCall}
        className="mt-4 w-full rounded-xl bg-foreground text-background py-3.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
      >
        <Phone className="h-4 w-4" />
        Connect via AI-Bridge Call
      </button>
    </div>
  );
};
