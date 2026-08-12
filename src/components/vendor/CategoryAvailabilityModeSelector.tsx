import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import type { CategoryServiceMode } from "@/lib/categories";
import type { AvailabilityMode } from "@/lib/vendorRegistration";
import {
  ensureCatalogBaseModes,
} from "@/lib/categoryAvailabilityModes";

type Props = {
  value: AvailabilityMode[];
  onChange: (next: AvailabilityMode[]) => void;
  catalogServiceMode: CategoryServiceMode;
  /** Compact pill style (My Business) vs card style (registration). */
  variant?: "cards" | "pills";
  testIdPrefix?: string;
  className?: string;
  label?: string;
  required?: boolean;
};

function YesNoToggle({
  question,
  yesLabel,
  noLabel,
  value,
  onChange,
  yesTestId,
  noTestId,
  variant,
}: {
  question: string;
  yesLabel: string;
  noLabel: string;
  value: boolean;
  onChange: (next: boolean) => void;
  yesTestId: string;
  noTestId: string;
  variant: "cards" | "pills";
}) {
  const optionClass = (selected: boolean) =>
    cn(
      variant === "pills"
        ? "rounded-full border px-3 py-1.5 text-sm font-medium"
        : "rounded-xl border p-3 text-sm font-medium text-left w-full",
      selected ? "border-primary bg-primary/15 ring-1 ring-primary/30" : "border-border bg-card",
    );

  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground">{question}</p>
      <div className={cn("flex gap-2", variant === "cards" && "flex-col sm:flex-row")}>
        <button
          type="button"
          role="radio"
          aria-checked={value}
          data-testid={yesTestId}
          onClick={() => onChange(true)}
          className={optionClass(value)}
        >
          {yesLabel}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          data-testid={noTestId}
          onClick={() => onChange(false)}
          className={optionClass(!value)}
        >
          {noLabel}
        </button>
      </div>
    </div>
  );
}

function ModeStatement({
  testId,
  children,
  variant,
}: {
  testId: string;
  children: ReactNode;
  variant: "cards" | "pills";
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "text-sm text-foreground",
        variant === "cards"
          ? "rounded-2xl border-2 border-primary/40 bg-primary/10 p-3"
          : "rounded-xl border border-primary/30 bg-primary/10 px-3 py-2",
      )}
    >
      {children}
    </div>
  );
}

export function CategoryAvailabilityModeSelector({
  value,
  onChange,
  catalogServiceMode,
  variant = "cards",
  testIdPrefix = "cat-avail",
  className,
  label,
  required = false,
}: Props) {
  const { s } = useLanguage();
  const selectedModes = ensureCatalogBaseModes(value, catalogServiceMode);

  const emit = (modes: AvailabilityMode[]) => {
    onChange(ensureCatalogBaseModes(modes, catalogServiceMode));
  };

  const renderHelpDefault = () => (
    <div className="space-y-3" data-testid={`${testIdPrefix}-modes`}>
      <ModeStatement testId={`${testIdPrefix}-help-on`} variant={variant}>
        {s.reg_avail_help_on_statement}
      </ModeStatement>
      <YesNoToggle
        question={s.reg_avail_advance_bookings_question}
        yesLabel={s.reg_avail_yes}
        noLabel={s.reg_avail_no}
        value={selectedModes.includes("appointment")}
        onChange={(yes) => emit(yes ? ["help", "appointment"] : ["help"])}
        yesTestId={`${testIdPrefix}-bookings-yes`}
        noTestId={`${testIdPrefix}-bookings-no`}
        variant={variant}
      />
    </div>
  );

  const renderDeliveryDefault = () => {
    const delivers = selectedModes.includes("delivery");
    return (
      <div className="space-y-3" data-testid={`${testIdPrefix}-modes`}>
        <YesNoToggle
          question={s.reg_avail_deliver_question}
          yesLabel={s.reg_avail_deliver_yes}
          noLabel={s.reg_avail_pickup_only}
          value={delivers}
          onChange={(yes) => emit(yes ? ["delivery"] : ["appointment"])}
          yesTestId={`${testIdPrefix}-deliver-yes`}
          noTestId={`${testIdPrefix}-pickup-only`}
          variant={variant}
        />
      </div>
    );
  };

  const renderAppointmentDefault = () => (
    <div className="space-y-3" data-testid={`${testIdPrefix}-modes`}>
      <ModeStatement testId={`${testIdPrefix}-appointment-on`} variant={variant}>
        {s.reg_avail_appointment_on_statement}
      </ModeStatement>
      <YesNoToggle
        question={s.reg_avail_same_day_question}
        yesLabel={s.reg_avail_yes}
        noLabel={s.reg_avail_no}
        value={selectedModes.includes("help")}
        onChange={(yes) => emit(yes ? ["appointment", "help"] : ["appointment"])}
        yesTestId={`${testIdPrefix}-same-day-yes`}
        noTestId={`${testIdPrefix}-same-day-no`}
        variant={variant}
      />
    </div>
  );

  return (
    <div className={className} role="group" aria-label={label}>
      {label != null && (
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {required ? " *" : ""}
        </label>
      )}
      <div className={cn(label != null && "mt-2")}>
        {catalogServiceMode === "help"
          ? renderHelpDefault()
          : catalogServiceMode === "delivery"
            ? renderDeliveryDefault()
            : renderAppointmentDefault()}
      </div>
    </div>
  );
}
