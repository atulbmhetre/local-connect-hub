import { useLanguage } from "@/lib/language";
import {
  PAN_INDIA_RADIUS_KM,
  SERVICE_RADIUS_OPTIONS,
  type ServiceRadiusKm,
} from "@/lib/serviceRadius";
import { cn } from "@/lib/utils";

type Strings = ReturnType<typeof useLanguage>["s"];

function labelForKm(km: ServiceRadiusKm, s: Strings): string {
  switch (km) {
    case 5:
      return s.vendor_radius_5;
    case 15:
      return s.vendor_radius_15;
    case 25:
      return s.vendor_radius_25;
    case 50:
      return s.vendor_radius_50;
    case 100:
      return s.vendor_radius_100;
    case 500:
      return s.vendor_radius_500;
    case PAN_INDIA_RADIUS_KM:
      return s.vendor_radius_india;
    default:
      return s.vendor_radius_15;
  }
}

type Props = {
  value: number | null;
  onChange: (km: ServiceRadiusKm) => void;
  disabled?: boolean;
};

export function ServiceRadiusChips({ value, onChange, disabled }: Props) {
  const { s } = useLanguage();

  return (
    <div className="flex flex-wrap gap-2">
      {SERVICE_RADIUS_OPTIONS.map((km) => (
        <button
          key={km}
          type="button"
          disabled={disabled}
          onClick={() => onChange(km)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-[0.98]",
            value === km
              ? "border-primary bg-primary/15 text-primary ring-1 ring-primary/30"
              : "border-surface-border bg-surface text-muted-foreground",
            disabled && "opacity-50",
          )}
        >
          {labelForKm(km, s)}
        </button>
      ))}
    </div>
  );
}
