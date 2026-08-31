import { describe, expect, it } from "vitest";
import {
  deliveryCartSubtotal,
  formatMinDeliveryOrderAmount,
  meetsMinDeliveryOrder,
  parseMinDeliveryOrderInput,
} from "./deliveryMinOrder";

describe("delivery min order helpers", () => {
  it("parses blank/zero as unset", () => {
    expect(parseMinDeliveryOrderInput("")).toBeNull();
    expect(parseMinDeliveryOrderInput("0")).toBeNull();
    expect(parseMinDeliveryOrderInput("150")).toBe(150);
  });

  it("sums quantity × unit_price from live selection", () => {
    expect(
      deliveryCartSubtotal(
        { a: 2, b: 1, c: 0 },
        [
          { id: "a", price: 50 },
          { id: "b", price: 80 },
          { id: "c", price: 999 },
        ],
      ),
    ).toBe(180);
  });

  it("treats missing or unpriced catalog rows as 0 contribution", () => {
    expect(deliveryCartSubtotal({ missing: 3 }, [{ id: "a", price: 10 }])).toBe(0);
    expect(deliveryCartSubtotal({ a: 2 }, [{ id: "a", price: 0 }])).toBe(0);
  });

  it("meets min only when subtotal is at or above", () => {
    expect(meetsMinDeliveryOrder(0, null)).toBe(true);
    expect(meetsMinDeliveryOrder(149, 150)).toBe(false);
    expect(meetsMinDeliveryOrder(150, 150)).toBe(true);
    expect(formatMinDeliveryOrderAmount(150.4)).toBe(150);
  });
});
