import { describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { desktopKhataHref, isWebDesktopShell } from "@/lib/desktopShell";

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
