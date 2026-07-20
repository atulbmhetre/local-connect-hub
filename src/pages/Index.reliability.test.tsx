import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Index from "./Index";

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  fetchCategories: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: mocks.captureError }));

vi.mock("@/lib/language", async () => {
  const { strings } = await vi.importActual<typeof import("@/lib/strings")>("@/lib/strings");
  return { useLanguage: () => ({ s: strings.en, lang: "en" }) };
});

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: { vendorStoppedMinutes: 15 },
  }),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "unit-device" }));
vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "8800012345",
  hasBeenWelcomed: () => true,
  markWelcomed: vi.fn(),
}));
vi.mock("@/lib/pushNotifications", () => ({ registerUserPushToken: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  fetchCategories: mocks.fetchCategories,
  groupCategoriesByMode: vi.fn(() => []),
  classifySearchTermForRadar: vi.fn(),
  emojiForVendorCategory: vi.fn(() => "🏪"),
  useCategoryLabel: () => (label: string) => label,
  supabase: {
    rpc: mocks.rpc,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({}),
    })),
    removeChannel: vi.fn(),
  },
}));

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/SOSButton", () => ({
  SOSButton: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>SOS</button>,
}));
vi.mock("@/components/CategoryPicker", () => ({ CategoryPicker: () => null }));
vi.mock("@/components/SearchSuggestSheet", () => ({
  SearchSuggestSheet: () => null,
  SUGGEST_TIER1_COUNT: 5,
}));
vi.mock("@/components/ParchiSheet", () => ({ ParchiSheet: () => null }));
vi.mock("@/components/AiBridgeSheet", () => ({ AiBridgeSheet: () => null }));
vi.mock("@/components/NeighbourSheet", () => ({ NeighbourSheet: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/FirstOpenFlow", () => ({ FirstOpenFlow: () => null }));
vi.mock("@/components/settings/SettingsSection", () => ({
  SettingsPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsSectionLabel: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

describe("Home load failures", () => {
  beforeEach(() => {
    mocks.captureError.mockClear();
    mocks.fetchCategories.mockRejectedValue(new Error("categories failed"));
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "get_saved_vendor_removal_notices") {
        return { data: [], error: null };
      }
      return { data: null, error: { message: `${name} failed` } };
    });
  });

  it("renders distinct error states and captures every failed Home load", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Index />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("home-saved-neighbours-error")).toBeVisible();
    expect(await screen.findByTestId("home-categories-error")).toBeVisible();
    expect(await screen.findByTestId("home-active-orders-error")).toBeVisible();
    expect(await screen.findByTestId("home-help-banner-error")).toBeVisible();

    await waitFor(() => expect(mocks.captureError).toHaveBeenCalledTimes(4));
    expect(mocks.captureError.mock.calls.map((call) => call[1]?.operation).sort()).toEqual([
      "fetch_categories",
      "get_my_active_order_count",
      "get_my_help_banner_orders",
      "get_saved_vendors",
    ]);
  });
});
