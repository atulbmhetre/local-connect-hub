import { describe, expect, it } from "vitest";
import { isValidPhone } from "@/lib/supabase";
import { isValidIndianMobile, normalizePhoneDigits } from "@/lib/indianPhone";

describe("R1 — vendor phone must be a valid 10-digit Indian mobile", () => {
  it("accepts a genuine 10-digit Indian mobile (leading 6–9)", () => {
    expect(isValidPhone("9876543210")).toBe(true);
    expect(isValidPhone("6123456789")).toBe(true);
    expect(isValidPhone("+91 9876543210")).toBe(true);
    expect(isValidPhone("91-9876543210")).toBe(true);
    expect(isValidPhone("919876543210")).toBe(true);
  });

  it("agrees with isValidIndianMobile / normalizePhoneDigits", () => {
    expect(isValidIndianMobile("919876543210")).toBe(true);
    expect(normalizePhoneDigits("919876543210")).toBe("9876543210");
    expect(isValidPhone("919876543210")).toBe(isValidIndianMobile("919876543210"));
  });

  it("rejects too-short numbers", () => {
    expect(isValidPhone("98765")).toBe(false);
    expect(isValidPhone("987654321")).toBe(false);
  });

  it("rejects too-long numbers", () => {
    expect(isValidPhone("98765432101")).toBe(false);
    expect(isValidPhone("987654321012")).toBe(false);
  });

  it("rejects numbers that contain letters", () => {
    expect(isValidPhone("98765abc10")).toBe(false);
    expect(isValidPhone("abcdefghij")).toBe(false);
  });

  it("rejects missing or wrong leading digit (must start 6–9)", () => {
    expect(isValidPhone("5876543210")).toBe(false);
    expect(isValidPhone("0876543210")).toBe(false);
    expect(isValidPhone("1876543210")).toBe(false);
  });
});
