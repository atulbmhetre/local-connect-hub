import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { APP_COLUMN_WIDTH_CLASS } from "@/lib/appColumn";
import { sheetVariants } from "@/components/ui/sheet";

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      nav_home: "Home",
      nav_feed: "Feed",
      nav_orders: "Orders",
      nav_vendor: "Vendor",
      nav_settings: "Settings",
      nav_vendor_online: "Live",
      nav_vendor_offline: "Offline",
    },
  }),
}));

vi.mock("@/lib/vendorSessionSync", () => ({
  readHasVendorId: () => false,
  readIsVendorActive: () => false,
  VENDOR_ACTIVE_CHANGED_EVENT: "aaspaas:vendor_active",
  VENDOR_ID_CHANGED_EVENT: "aaspaas:vendor_id",
}));

describe("desktop column chrome", () => {
  it("constrains BottomNav visible chrome to the app column", () => {
    render(
      <MemoryRouter>
        <BottomNav />
      </MemoryRouter>,
    );
    const chrome = screen.getByTestId("bottom-nav-chrome");
    expect(chrome.className).toContain(APP_COLUMN_WIDTH_CLASS);
    expect(chrome.className).toContain("mx-auto");
  });

  it("constrains side=bottom sheets to the same max-w-md column", () => {
    expect(sheetVariants({ side: "bottom" })).toContain("max-w-md");
    expect(sheetVariants({ side: "bottom" })).toContain("mx-auto");
  });

  it("leaves Live Tracking full-viewport (no AppShell column)", () => {
    const src = readFileSync(resolve("src/pages/LiveTracking.tsx"), "utf8");
    expect(src).not.toMatch(/AppShell/);
    expect(src).not.toMatch(/max-w-md/);
  });
});
