import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uuidMock = vi.fn();

vi.mock("@/lib/safeRandomUUID", () => ({
  safeRandomUUID: () => uuidMock(),
}));

import {
  buildOrderPlacementFingerprint,
  clearOrderPlacementIdempotencyKey,
  getOrCreateOrderPlacementIdempotencyKey,
} from "@/lib/orderPlacementIdempotency";

const baseParts = {
  vendorId: "vendor-1",
  phone: "9876543210",
  message: "two kg tomatoes",
  serviceMode: "delivery",
  deliverySlot: "morning" as string | null,
  appointmentTimestamp: null as string | null,
  appointmentInstant: false,
  address: "Lane 1",
  itemsJson: "null",
  recurrenceKind: "one_time",
  recurrenceCustomDays: "",
  serviceLocation: null as string | null,
};

describe("orderPlacementIdempotency", () => {
  beforeEach(() => {
    uuidMock.mockReset();
    let n = 0;
    uuidMock.mockImplementation(() => {
      n += 1;
      return `uuid-${n}`;
    });
    clearOrderPlacementIdempotencyKey("vendor-1");
    sessionStorage.clear();
  });

  afterEach(() => {
    clearOrderPlacementIdempotencyKey("vendor-1");
    sessionStorage.clear();
  });

  it("reuses the same key for the same composition (Retry)", () => {
    const fp = buildOrderPlacementFingerprint(baseParts);
    const first = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp);
    const second = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp);
    expect(first).toBe("uuid-1");
    expect(second).toBe("uuid-1");
    expect(uuidMock).toHaveBeenCalledTimes(1);
  });

  it("mints a new key when composition changes", () => {
    const fp1 = buildOrderPlacementFingerprint(baseParts);
    const first = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp1);
    const fp2 = buildOrderPlacementFingerprint({
      ...baseParts,
      message: "two kg onions",
    });
    const second = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp2);
    expect(first).toBe("uuid-1");
    expect(second).toBe("uuid-2");
  });

  it("clears so the next attempt gets a fresh key", () => {
    const fp = buildOrderPlacementFingerprint(baseParts);
    const first = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp);
    clearOrderPlacementIdempotencyKey("vendor-1");
    const second = getOrCreateOrderPlacementIdempotencyKey("vendor-1", fp);
    expect(first).toBe("uuid-1");
    expect(second).toBe("uuid-2");
  });
});
