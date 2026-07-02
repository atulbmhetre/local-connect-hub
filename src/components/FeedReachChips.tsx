import { useLanguage } from "@/lib/language";
import {
  FEED_REACH_CHIP_OPTIONS,
  FEED_REACH_CITY_WIDE_KM,
  isFeedCityWideKm,
} from "@/lib/feedReach";
import { cn } from "@/lib/utils";

type Props = {
  /** reader: NULL = city-wide cap off; poster: 9999 = city-wide post reach */
  mode: "reader" | "poster";
  value: number | null;
  onChange: (km: number | null) => void;
  options?: number[];
  disabled?: boolean;
};

function activeChipValue(mode: "reader" | "poster", value: number | null): number {
  if (mode === "reader") {
    return value == null ? FEED_REACH_CITY_WIDE_KM : value;
  }
  return value == null || isFeedCityWideKm(value) ? FEED_REACH_CITY_WIDE_KM : value;
}

export function FeedReachChips({ mode, value, onChange, options, disabled }: Props) {
  const { s } = useLanguage();
  const chips = options ?? [...FEED_REACH_CHIP_OPTIONS, FEED_REACH_CITY_WIDE_KM];
  const activeValue = activeChipValue(mode, value);

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((km) => {
        const isCityWide = isFeedCityWideKm(km);
        const label = isCityWide ? s.feed_reachCityWide : s.feed_reachKm(km);
        const chipValue = isCityWide ? FEED_REACH_CITY_WIDE_KM : km;
        return (
          <button
            key={isCityWide ? "city" : km}
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange(
                isCityWide
                  ? mode === "reader"
                    ? null
                    : FEED_REACH_CITY_WIDE_KM
                  : km,
              )
            }
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-[0.98]",
              activeValue === chipValue
                ? "border-primary bg-primary/15 text-primary ring-1 ring-primary/30"
                : "border-surface-border bg-surface text-muted-foreground",
              disabled && "opacity-50",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
