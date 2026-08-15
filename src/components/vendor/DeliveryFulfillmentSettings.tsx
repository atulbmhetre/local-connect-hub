import { cn } from "@/lib/utils";
import type { DeliveryFulfillmentMethod, DeliveryPaymentTiming } from "@/lib/deliveryFulfillment";
import { useLanguage } from "@/lib/language";

type Props = {
  fulfillment: DeliveryFulfillmentMethod;
  paymentTiming: DeliveryPaymentTiming;
  onFulfillmentChange: (method: DeliveryFulfillmentMethod) => void;
  onPaymentTimingChange: (timing: DeliveryPaymentTiming) => void;
  testIdPrefix?: string;
  compact?: boolean;
};

export function DeliveryFulfillmentSettings({
  fulfillment,
  paymentTiming,
  onFulfillmentChange,
  onPaymentTimingChange,
  testIdPrefix = "delivery-fulfillment",
  compact = false,
}: Props) {
  const { s } = useLanguage();

  const pillClass = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
      active
        ? "bg-brand text-white border-brand"
        : "border-surface-border text-muted-foreground bg-surface",
    );

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <div>
        {!compact && (
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {s.delivery_fulfillment_label}
          </label>
        )}
        <div
          className={cn("flex flex-wrap gap-2", !compact && "mt-2")}
          data-testid={`${testIdPrefix}-method`}
        >
          <button
            type="button"
            data-testid={`${testIdPrefix}-method-vendor`}
            onClick={() => onFulfillmentChange("vendor")}
            className={pillClass(fulfillment === "vendor")}
          >
            {s.delivery_fulfillment_vendor}
          </button>
          <button
            type="button"
            data-testid={`${testIdPrefix}-method-agent`}
            onClick={() => onFulfillmentChange("agent")}
            className={pillClass(fulfillment === "agent")}
          >
            {s.delivery_fulfillment_agent}
          </button>
        </div>
      </div>

      {fulfillment === "agent" && (
        <div>
          {!compact && (
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.delivery_payment_timing_label}
            </label>
          )}
          <div
            className={cn("flex flex-wrap gap-2", !compact && "mt-2")}
            data-testid={`${testIdPrefix}-timing`}
          >
            <button
              type="button"
              data-testid={`${testIdPrefix}-timing-prepaid`}
              onClick={() => onPaymentTimingChange("prepaid")}
              className={pillClass(paymentTiming === "prepaid")}
            >
              {s.delivery_payment_prepaid}
            </button>
            <button
              type="button"
              data-testid={`${testIdPrefix}-timing-postpaid`}
              onClick={() => onPaymentTimingChange("postpaid")}
              className={pillClass(paymentTiming === "postpaid")}
            >
              {s.delivery_payment_postpaid}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
