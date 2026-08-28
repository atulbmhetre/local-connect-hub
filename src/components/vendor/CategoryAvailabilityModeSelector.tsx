import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import type { CategoryServiceMode } from "@/lib/categories";
import type { AvailabilityMode } from "@/lib/vendorRegistration";
import {
  ensureCatalogBaseModes,
  helpAppointmentChoiceToModes,
  helpAppointmentModesToChoice,
  type HelpAppointmentChoice,
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

function ThreeWayChoice({
  question,
  choice,
  onChange,
  urgentLabel,
  scheduledLabel,
  bothLabel,
  testIdPrefix,
  variant,
}: {
  question: string;
  choice: HelpAppointmentChoice | null;
  onChange: (next: HelpAppointmentChoice) => void;
  urgentLabel: string;
  scheduledLabel: string;
  bothLabel: string;
  testIdPrefix: string;
  variant: "cards" | "pills";
}) {
  const optionClass = (selected: boolean) =>
    cn(
      variant === "pills"
        ? "rounded-full border px-3 py-1.5 text-sm font-medium text-left"
        : "rounded-xl border p-3 text-sm font-medium text-left w-full",
      selected ? "border-primary bg-primary/15 ring-1 ring-primary/30" : "border-border bg-card",
    );

  const options: { id: HelpAppointmentChoice; label: string; testId: string }[] = [
    { id: "urgent", label: urgentLabel, testId: `${testIdPrefix}-choice-urgent` },
    { id: "scheduled", label: scheduledLabel, testId: `${testIdPrefix}-choice-scheduled` },
    { id: "both", label: bothLabel, testId: `${testIdPrefix}-choice-both` },
  ];

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-modes`} role="radiogroup" aria-label={question}>
      <p className="text-sm text-foreground">{question}</p>
      <div className={cn("flex gap-2", variant === "cards" ? "flex-col" : "flex-col sm:flex-row sm:flex-wrap")}>
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={choice === opt.id}
            data-testid={opt.testId}
            onClick={() => onChange(opt.id)}
            className={optionClass(choice === opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
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

  const renderHelpOrAppointmentThreeWay = () => {
    const choice = helpAppointmentModesToChoice(selectedModes);
    return (
      <ThreeWayChoice
        question={s.reg_avail_three_way_question}
        choice={choice}
        onChange={(next) => emit(helpAppointmentChoiceToModes(next))}
        urgentLabel={s.reg_avail_choice_urgent}
        scheduledLabel={s.reg_avail_choice_scheduled}
        bothLabel={s.reg_avail_choice_both}
        testIdPrefix={testIdPrefix}
        variant={variant}
      />
    );
  };

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

  return (
    <div className={className} role="group" aria-label={label}>
      {label != null && (
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {required ? " *" : ""}
        </label>
      )}
      <div className={cn(label != null && "mt-2")}>
        {catalogServiceMode === "delivery"
          ? renderDeliveryDefault()
          : renderHelpOrAppointmentThreeWay()}
      </div>
    </div>
  );
}
