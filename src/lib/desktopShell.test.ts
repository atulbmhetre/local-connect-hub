import { describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  desktopBottomSheetClass,
  desktopKhataHref,
  desktopSheetOverlayClass,
  isWebDesktopShell,
} from "@/lib/desktopShell";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

describe("isWebDesktopShell", () => {
  it("is true on web so lg: classes can apply", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(isWebDesktopShell()).toBe(true);
  });

  it("is false on Capacitor so native never gets the desktop sidebar", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(isWebDesktopShell()).toBe(false);
  });
});

describe("desktop bottom sheets", () => {
  it("offsets and widens sheets to the content well on web", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(desktopSheetOverlayClass()).toContain("lg:left-64");
    expect(desktopBottomSheetClass()).toContain("lg:left-64");
    expect(desktopBottomSheetClass()).toContain("lg:max-w-3xl");
  });

  it("does not offset sheets on Capacitor", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(desktopSheetOverlayClass()).toBe("");
    expect(desktopBottomSheetClass()).toBe("");
  });
});
describe("desktopKhataHref", () => {
  it("sends vendors to /ledger", () => {
    expect(desktopKhataHref(true)).toBe("/ledger");
  });

  it("sends customers to the My Orders Khata section, not /vendor", () => {
    expect(desktopKhataHref(false)).toBe("/my-orders#khata");
    expect(desktopKhataHref(false)).not.toContain("/vendor");
    expect(desktopKhataHref(false)).not.toBe("/ledger");
  });
});
