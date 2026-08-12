import { describe, expect, it } from "vitest";
import { toCapturedError } from "@/lib/sentry";

describe("toCapturedError", () => {
  it("wraps PostgREST error objects with readable messages", () => {
    const err = toCapturedError({
      code: "P0001",
      details: null,
      hint: null,
      message: "not_found_or_unauthorized",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("not_found_or_unauthorized (P0001)");
  });

  it("passes through Error instances unchanged", () => {
    const original = new Error("already wrapped");
    expect(toCapturedError(original)).toBe(original);
  });
});
