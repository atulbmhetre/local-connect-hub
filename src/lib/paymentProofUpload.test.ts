import { describe, expect, it, vi } from "vitest";
import {
  PAYMENT_PROOF_MAX_BYTES,
  PaymentProofValidationError,
  assertPaymentProofBlob,
} from "@/lib/paymentProofUpload";

vi.mock("@/lib/prepareImageBlob", () => ({
  prepareImageBlob: vi.fn(async (blob: Blob) => blob),
  IMAGE_UPLOAD_MAX_EDGE_PX: 2048,
  IMAGE_UPLOAD_MAX_BYTES: 5_242_880,
}));

describe("paymentProofUpload client gate", () => {
  it("accepts small jpeg blobs", () => {
    expect(() =>
      assertPaymentProofBlob(new Blob([new Uint8Array(64)], { type: "image/jpeg" })),
    ).not.toThrow();
  });

  it("rejects oversize blobs before upload", () => {
    expect(() =>
      assertPaymentProofBlob(
        new Blob([new Uint8Array(PAYMENT_PROOF_MAX_BYTES + 1)], { type: "image/jpeg" }),
      ),
    ).toThrow(PaymentProofValidationError);
  });
});
