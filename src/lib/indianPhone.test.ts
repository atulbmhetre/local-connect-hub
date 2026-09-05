import { describe, expect, it } from "vitest";
import {
  isSamePhone,
  isValidIndianMobile,
  isValidPhone,
  normalizeAuthPhone,
  normalizePhoneDigits,
} from "@/lib/indianPhone";
import { feedAuthorLabel } from "@/lib/khataDisplay";

const NATIONAL = "9876543210";

describe("normalizePhoneDigits (canonical)", () => {
  it("maps +91 / 91 / bare 10-digit forms to the same national number", () => {
    expect(normalizePhoneDigits("+91 9876543210")).toBe(NATIONAL);
    expect(normalizePhoneDigits("919876543210")).toBe(NATIONAL);
    expect(normalizePhoneDigits("9876543210")).toBe(NATIONAL);
    expect(normalizePhoneDigits("91-9876543210")).toBe(NATIONAL);
  });

  it("is identical to normalizeAuthPhone", () => {
    for (const raw of ["+91 9876543210", "919876543210", "9876543210", "", null]) {
      expect(normalizeAuthPhone(raw)).toBe(normalizePhoneDigits(raw));
    }
  });

  it("returns null for unusable input", () => {
    expect(normalizePhoneDigits("")).toBeNull();
    expect(normalizePhoneDigits("98765")).toBeNull();
    expect(normalizePhoneDigits(null)).toBeNull();
    expect(normalizePhoneDigits(undefined)).toBeNull();
  });
});

describe("isSamePhone — feed / khata identity", () => {
  it("treats +91, 91-prefixed, and bare forms as the same phone", () => {
    expect(isSamePhone("+91 9876543210", "9876543210")).toBe(true);
    expect(isSamePhone("919876543210", "9876543210")).toBe(true);
    expect(isSamePhone("+91 9876543210", "919876543210")).toBe(true);
  });

  it("does not treat different national numbers as the same", () => {
    expect(isSamePhone("9876543210", "9876543211")).toBe(false);
  });
});

describe("feedAuthorLabel — own post shows You (was broken for 91-prefix)", () => {
  it("labels the viewer as You when stored post phone is 91-prefixed and viewer is bare", () => {
    expect(feedAuthorLabel("919876543210", "9876543210")).toBe("You");
    expect(feedAuthorLabel("9876543210", "919876543210")).toBe("You");
    expect(feedAuthorLabel("+91 9876543210", "9876543210")).toBe("You");
  });

  it("masks other authors", () => {
    expect(feedAuthorLabel("9876543210", "9123456789")).toMatch(/^••••/);
  });
});

describe("isValidIndianMobile / isValidPhone (SQL-aligned)", () => {
  it("accepts the same shapes as registration / OTP entry", () => {
    expect(isValidPhone("9876543210")).toBe(true);
    expect(isValidIndianMobile("+91 9876543210")).toBe(true);
    expect(isValidIndianMobile("919876543210")).toBe(true);
    expect(isValidPhone("91-9876543210")).toBe(true);
    expect(isValidPhone("6123456789")).toBe(true);
  });

  it("rejects wrong length and leading digit outside 6–9", () => {
    expect(isValidPhone("98765")).toBe(false);
    expect(isValidPhone("98765432101")).toBe(false);
    expect(isValidPhone("5876543210")).toBe(false);
    expect(isValidPhone("0876543210")).toBe(false);
    expect(isValidIndianMobile(null)).toBe(false);
  });
});
