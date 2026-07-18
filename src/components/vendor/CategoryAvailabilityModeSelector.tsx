import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import type { AvailabilityMode } from "@/lib/vendorRegistration";
import { toggleAvailabilityMode } from "@/lib/categoryAvailabilityModes";

type Props = {
  value: AvailabilityMode[];
  onChange: (next: AvailabilityMode[]) => void;
  /** When false, the last selected mode cannot be cleared. Default true. */
  allowEmpty?: boolean;
  /** Compact pill style (My Business) vs card style (registration). */
  variant?: "cards" | "pills";
  testIdPrefix?: string;
  className?: string;
  label?: string;
  required?: boolean;
};

export function CategoryAvailabilityModeSelector({
  value,
  onChange,
  allowEmpty = false,
  variant = "cards",
  testIdPrefix = "cat-avail",
  className,
  label,
  required = false,
}: Props) {
  const { s } = useLanguage();

  const options = [
    {
      mode: "help" as const,
      emoji: "⚡",
      title: s.reg_avail_help,
      desc: s.reg_avail_help_desc,
    },
    {
      mode: "delivery" as const,
      emoji: "🛒",
      title: s.reg_avail_delivery,
      desc: s.reg_avail_delivery_desc,
    },
    {
      mode: "appointment" as const,
      emoji: "📅",
      title: s.reg_avail_appointment,
      desc: s.reg_avail_appointment_desc,
    },
  ] as const;

  return (
    <div className={className}>
      {label != null && (
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {required ? " *" : ""}
        </label>
      )}
      <div
        className={cn(
          "flex flex-wrap gap-2",
          label != null && "mt-2",
          variant === "cards" && "items-stretch",
        )}
        data-testid={`${testIdPrefix}-modes`}
      >
        {options.map((opt) => {
          const selected = value.includes(opt.mode);
          if (variant === "pills") {
            return (
              <button
                key={opt.mode}
                type="button"
                data-testid={`${testIdPrefix}-${opt.mode}`}
                onClick={() =>
                  onChange(toggleAvailabilityMode(value, opt.mode, { allowEmpty }))
                }
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium",
                  selected ? "border-primary bg-primary/20" : "border-border",
                )}
              >
                {opt.title}
              </button>
            );
          }
          return (
            <button
              key={opt.mode}
              type="button"
              data-testid={`${testIdPrefix}-${opt.mode}`}
              onClick={() =>
                onChange(toggleAvailabilityMode(value, opt.mode, { allowEmpty }))
              }
              className={cn(
                "rounded-2xl border-2 p-3 text-left min-w-[140px] flex-1",
                selected
                  ? "border-primary bg-primary/15 ring-1 ring-primary/30"
                  : "border-surface-border bg-surface",
              )}
            >
              <p className="font-semibold text-sm">
                {opt.emoji} {opt.title}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
