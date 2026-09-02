import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { APP_COLUMN_WIDTH_CLASS } from "@/lib/appColumn";
import {
  DESKTOP_CONTENT_WIDTH_CLASS,
  DESKTOP_MAIN_OFFSET_CLASS,
  LG_MEDIA_QUERY,
} from "@/lib/desktopShell";
import { Capacitor } from "@capacitor/core";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === LG_MEDIA_QUERY ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      appName: "Aaspaas Pro",
      nav_home: "Home",
      nav_orders: "Orders",
      nav_settings: "Settings",
      khata_wordLabel: "Khata",
      notif_bell_title: "Notifications",
      notif_bell_aria_label: "Notifications",
      vendor_mode_title: "Vendor Mode",
      nav_feed: "Feed",
      nav_vendor: "Vendor",
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

vi.mock("@/components/NotificationBell", () => ({
  NotificationBell: ({ navLabel }: { navLabel?: string }) => (
    <button type="button" data-testid="desktop-nav-notifications">
      {navLabel}
    </button>
  ),
}));

describe("AppShell desktop layout", () => {
  beforeEach(() => {
    stubMatchMedia(true);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  it("keeps the phone column and still mounts BottomNav on web", () => {
    render(
      <MemoryRouter>
        <AppShell>
          <p>content</p>
        </AppShell>
      </MemoryRouter>,
    );
    const main = screen.getByTestId("app-shell-main");
    expect(main.className).toContain(APP_COLUMN_WIDTH_CLASS);
    expect(main.className).toContain("pt-8");
    expect(main.className).toContain("px-4");
    expect(main.className).not.toContain("lg:pt-10");
    expect(main.className).not.toContain("lg:px-8");
    expect(main.className).toContain(DESKTOP_CONTENT_WIDTH_CLASS);
    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();
    expect(screen.getByTestId("bottom-nav-chrome")).toBeTruthy();
    expect(screen.getByTestId("bottom-nav-chrome").closest("nav")?.className).toContain(
      "lg:hidden",
    );
  });

  it("does not mount the sidebar on Capacitor and leaves BottomNav un-gated", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    stubMatchMedia(true);
    render(
      <MemoryRouter>
        <AppShell>
          <p>content</p>
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    const main = screen.getByTestId("app-shell-main");
    expect(main.className).toContain(APP_COLUMN_WIDTH_CLASS);
    expect(main.className).not.toContain(DESKTOP_CONTENT_WIDTH_CLASS);
    expect(screen.getByTestId("bottom-nav-chrome").closest("nav")?.className).not.toContain(
      "lg:hidden",
    );
  });

  it("does not mount the sidebar below lg on web", () => {
    stubMatchMedia(false);
    render(
      <MemoryRouter>
        <AppShell>
          <p>content</p>
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    expect(screen.getByTestId("bottom-nav-chrome")).toBeTruthy();
  });

  it("offsets main content for the sidebar only when the web desktop shell is on", () => {
    render(
      <MemoryRouter>
        <AppShell>
          <p>content</p>
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("app-shell-main").parentElement?.className).toContain(
      DESKTOP_MAIN_OFFSET_CLASS,
    );
  });
});
