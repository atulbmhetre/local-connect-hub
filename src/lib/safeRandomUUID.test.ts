import { describe, expect, it, vi } from "vitest";
import { safeRandomUUID } from "./safeRandomUUID";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("safeRandomUUID", () => {
  it("returns a UUID v4-shaped string", () => {
    expect(safeRandomUUID()).toMatch(UUID_RE);
  });

  it("falls back when randomUUID throws (insecure context)", () => {
    const original = globalThis.crypto.randomUUID.bind(globalThis.crypto);
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("Secure context required");
    });
    try {
      const id = safeRandomUUID();
      expect(id).toMatch(UUID_RE);
    } finally {
      vi.mocked(globalThis.crypto.randomUUID).mockImplementation(original);
    }
  });
});
