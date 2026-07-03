import { describe, expect, it } from "vitest";
import { parseUpiPayeeIdFromQrPayload } from "@/pages/VendorMode";

describe("parseUpiPayeeIdFromQrPayload", () => {
  it("returns the VPA from a valid upi://pay payload", () => {
    expect(parseUpiPayeeIdFromQrPayload("upi://pay?pa=vendor@okhdfcbank&pn=Shop")).toBe(
      "vendor@okhdfcbank",
    );
  });

  it("returns null when pa is not a valid UPI VPA shape", () => {
    expect(parseUpiPayeeIdFromQrPayload("upi://pay?pa=notavalidvpa&pn=Shop")).toBeNull();
  });

  it("returns null for strings that do not start with upi://pay, even if they contain pa=", () => {
    expect(parseUpiPayeeIdFromQrPayload("not-a-qr-payload")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("https://example.com/pay")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("pa=vendor@okhdfcbank&pn=Shop")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("some-prefix?pa=foo@bank&am=100")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("companypa=xyz@bank")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("unrelated text with pa= embedded")).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(parseUpiPayeeIdFromQrPayload("")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("   ")).toBeNull();
  });

  it("returns null when upi://pay prefix is present but pa is empty", () => {
    expect(parseUpiPayeeIdFromQrPayload("upi://pay?pa=&pn=Shop")).toBeNull();
    expect(parseUpiPayeeIdFromQrPayload("upi://pay")).toBeNull();
  });
});
