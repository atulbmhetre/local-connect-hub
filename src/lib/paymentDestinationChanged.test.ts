import { describe, expect, it } from "vitest";
import {
  foldPaymentPhone,
  paymentDestinationsChanged,
  type BilledPaymentDestination,
} from "@/lib/paymentDestinationChanged";

const billed: BilledPaymentDestination = {
  billed_upi_id: "shop@upi",
  billed_upi_qr_url: "https://cdn.example/qr.png",
  billed_upi_payee_id: "shop@upi",
  billed_payment_phone: "9900011111",
  billed_payment_snapshot_at: "2026-08-30T07:00:00Z",
};

const liveMatch = {
  upiId: "shop@upi",
  qrUrl: "https://cdn.example/qr.png",
  qrPayeeId: "shop@upi",
  paymentPhone: "9900011111",
};

describe("paymentDestinationsChanged", () => {
  it("does not notify when billed snapshot is missing", () => {
    expect(
      paymentDestinationsChanged(
        { ...billed, billed_payment_snapshot_at: null },
        { ...liveMatch, upiId: "new@upi" },
      ),
    ).toBe(false);
    expect(paymentDestinationsChanged(null, liveMatch)).toBe(false);
  });

  it("does not notify when live UPI, QR, and mobile match the bill freeze", () => {
    expect(paymentDestinationsChanged(billed, liveMatch)).toBe(false);
    expect(
      paymentDestinationsChanged(billed, {
        ...liveMatch,
        upiId: " Shop@UPI ",
        paymentPhone: "+91 99000 11111",
      }),
    ).toBe(false);
  });

  it("notifies when any one destination field changed", () => {
    expect(paymentDestinationsChanged(billed, { ...liveMatch, upiId: "new@upi" })).toBe(true);
    expect(
      paymentDestinationsChanged(billed, {
        ...liveMatch,
        qrUrl: "https://cdn.example/qr-new.png",
      }),
    ).toBe(true);
    expect(
      paymentDestinationsChanged(billed, { ...liveMatch, qrPayeeId: "other@upi" }),
    ).toBe(true);
    expect(
      paymentDestinationsChanged(billed, { ...liveMatch, paymentPhone: "9900099999" }),
    ).toBe(true);
  });

  it("folds Indian phones to last 10 digits", () => {
    expect(foldPaymentPhone("+91 99000 11111")).toBe("9900011111");
    expect(foldPaymentPhone("09900011111")).toBe("9900011111");
  });
});
