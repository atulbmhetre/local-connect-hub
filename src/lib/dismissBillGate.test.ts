import { describe, expect, it } from "vitest";
import {
  billBlocksDismiss,
  resolveCustomerDismissSurfaceAction,
} from "./dismissBillGate";

describe("billBlocksDismiss", () => {
  it("blocks unpaid cash and upi", () => {
    expect(billBlocksDismiss({ payment_status: "unpaid", payment_mode: "cash" })).toBe(true);
    expect(billBlocksDismiss({ payment_status: "unpaid", payment_mode: "upi" })).toBe(true);
  });

  it("does not block paid, void, missing, or khata unpaid", () => {
    expect(billBlocksDismiss(null)).toBe(false);
    expect(billBlocksDismiss({ payment_status: "paid", payment_mode: "cash" })).toBe(false);
    expect(billBlocksDismiss({ payment_status: "void", payment_mode: "upi" })).toBe(false);
    expect(billBlocksDismiss({ payment_status: "unpaid", payment_mode: "khata" })).toBe(false);
  });

  it("allows dismiss when request payment is disputed even if bill unpaid", () => {
    expect(
      billBlocksDismiss({ payment_status: "unpaid", payment_mode: "upi" }, "disputed"),
    ).toBe(false);
    expect(
      billBlocksDismiss({ payment_status: "unpaid", payment_mode: "cash" }, "disputed"),
    ).toBe(false);
  });
});

describe("resolveCustomerDismissSurfaceAction", () => {
  it("prefers cancel when cancel is available even with unpaid bill", () => {
    expect(
      resolveCustomerDismissSurfaceAction({
        cancelAvailable: true,
        bill: { payment_status: "unpaid", payment_mode: "cash" },
      }),
    ).toBe("cancel");
  });

  it("blocks dismiss when cancel unavailable and bill unpaid cash/upi", () => {
    expect(
      resolveCustomerDismissSurfaceAction({
        cancelAvailable: false,
        bill: { payment_status: "unpaid", payment_mode: "upi" },
      }),
    ).toBe("blocked_unpaid");
  });

  it("allows dismiss when unpaid bill is disputed", () => {
    expect(
      resolveCustomerDismissSurfaceAction({
        cancelAvailable: false,
        bill: { payment_status: "unpaid", payment_mode: "upi" },
        requestPaymentStatus: "disputed",
      }),
    ).toBe("dismiss");
  });

  it("allows dismiss when cancel unavailable and bill paid or absent", () => {
    expect(
      resolveCustomerDismissSurfaceAction({
        cancelAvailable: false,
        bill: { payment_status: "paid", payment_mode: "cash" },
      }),
    ).toBe("dismiss");
    expect(
      resolveCustomerDismissSurfaceAction({ cancelAvailable: false, bill: null }),
    ).toBe("dismiss");
  });
});
