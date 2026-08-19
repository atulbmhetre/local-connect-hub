import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Index from "./Index";
import type { ClassifySearchForRadarResult } from "@/lib/supabase";
import { strings } from "@/lib/strings";

const mocks = vi.hoisted(() => ({
  classifySearchTermForRadar: vi.fn(),
  fetchCategories: vi.fn(),
  rpc: vi.fn(),
  toastInfo: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo, error: vi.fn(), success: vi.fn() },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("@/lib/language", async () => {
  const { strings } = await vi.importActual<typeof import("@/lib/strings")>("@/lib/strings");
  return { useLanguage: () => ({ s: strings.en, lang: "en" }) };
});

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({ config: { vendorStoppedMinutes: 15 } }),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "unit-device" }));
vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => null,
  hasBeenWelcomed: () => true,
  markWelcomed: vi.fn(),
}));
vi.mock("@/lib/pushNotifications", () => ({ registerUserPushToken: vi.fn() }));
vi.mock("@/lib/webPush", () => ({ registerWebPushIfPermitted: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

const CATS = [
  {
    id: "1",
    label: "Security",
    emoji: "🛡️",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 1,
  },
  {
    id: "2",
    label: "Mechanic",
    emoji: "🔧",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 2,
  },
  {
    id: "3",
    label: "Ambulance",
    emoji: "🚑",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 3,
  },
  {
    id: "4",
    label: "Plumber",
    emoji: "🚰",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 4,
  },
  {
    id: "5",
    label: "Electrician",
    emoji: "💡",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 5,
  },
  {
    id: "6",
    label: "Key Maker",
    emoji: "🔑",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 6,
  },
  {
    id: "7",
    label: "Nursing",
    emoji: "🩺",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 7,
  },
];

vi.mock("@/lib/supabase", () => ({
  fetchCategories: mocks.fetchCategories,
  groupCategoriesByMode: vi.fn((cats: typeof CATS) => [
    { service_mode: "help", label: "Help", categories: cats },
  ]),
  classifySearchTermForRadar: mocks.classifySearchTermForRadar,
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
  SOSButton: ({ onClick }: { onClick: () => void }) => (
    <button data-testid="home-sos-button" onClick={onClick}>
      SOS
    </button>
  ),
}));
vi.mock("@/components/CategoryPicker", () => ({ CategoryPicker: () => null }));
vi.mock("@/components/ParchiSheet", () => ({ ParchiSheet: () => null }));
vi.mock("@/components/AiBridgeSheet", () => ({ AiBridgeSheet: () => null }));
vi.mock("@/components/NeighbourSheet", () => ({ NeighbourSheet: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/FirstOpenFlow", () => ({ FirstOpenFlow: () => null }));
vi.mock("@/components/settings/SettingsSection", () => ({
  SettingsPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsSectionLabel: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const LOST =
  "I am lost and need someone to help me find the way out";

const TEN_CANDIDATES = CATS.concat([
  {
    id: "8",
    label: "Towing",
    emoji: "🚛",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 8,
  },
  {
    id: "9",
    label: "Therapist",
    emoji: "🧘",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 9,
  },
  {
    id: "10",
    label: "Maid",
    emoji: "🧹",
    service_mode: "help" as const,
    is_active: true,
    sort_order: 10,
  },
]).map((c) => ({ label: c.label, emoji: c.emoji, mode: c.service_mode }));

async function renderHome() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Index />
    </MemoryRouter>,
  );
  await screen.findByTestId("home-screen");
}

async function submitSearch(text: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form")!);
}

describe("Home tiered AI search suggestions", () => {
  beforeEach(() => {
    mocks.classifySearchTermForRadar.mockReset();
    mocks.fetchCategories.mockReset();
    mocks.rpc.mockReset();
    mocks.toastInfo.mockReset();
    mocks.navigate.mockReset();
    mocks.fetchCategories.mockResolvedValue(CATS);
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("exact category-label match navigates to Radar without opening the suggest sheet", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "exact",
      query: "Plumber",
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch("Plumber");

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith("/radar?q=Plumber"),
    );
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
  });

  it("an off-topic free-text query surfaces Tier 1 candidates and keeps the original text", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "candidates",
      candidates: TEN_CANDIDATES,
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch(LOST);

    const sheet = await screen.findByTestId("search-suggest-sheet");
    expect(within(sheet).getByTestId("search-suggest-original-text")).toHaveTextContent(LOST);
    expect(within(sheet).getByTestId("search-suggest-original-text")).not.toHaveTextContent(
      "Other",
    );

    // Tier 1 = top 5 only
    const options = within(sheet).getAllByTestId("search-suggest-option");
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.textContent)).toEqual(
      TEN_CANDIDATES.slice(0, 5).map((c) => `${c.emoji}${c.label}`),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('"None of these" reveals Tier 2 (remaining candidates, still no auto-navigate)', async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "candidates",
      candidates: TEN_CANDIDATES,
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch(LOST);

    const sheet = await screen.findByTestId("search-suggest-sheet");
    fireEvent.click(within(sheet).getByTestId("search-suggest-none"));

    await waitFor(() =>
      expect(within(sheet).getAllByTestId("search-suggest-option")).toHaveLength(10),
    );
    expect(within(sheet).getByTestId("search-suggest-original-text")).toHaveTextContent(LOST);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("tapping a candidate navigates to that category on Radar", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "candidates",
      candidates: TEN_CANDIDATES.slice(0, 3),
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch(LOST);

    const sheet = await screen.findByTestId("search-suggest-sheet");
    fireEvent.click(within(sheet).getByText("Mechanic"));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith("/radar?q=Mechanic&mode=help"),
    );
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
  });

  it("rephrasing is not offered after rejecting all suggestion tiers — shows unavailable", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "candidates",
      candidates: TEN_CANDIDATES.slice(0, 3),
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch("body care");

    const sheet = await screen.findByTestId("search-suggest-sheet");
    fireEvent.click(within(sheet).getByTestId("search-suggest-none"));

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        strings.en.search_category_unavailable,
        { duration: 4000 },
      ),
    );
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
    expect(screen.queryByTestId("search-suggest-rephrase-input")).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("rejecting Tier 1 then Tier 2 twice ends on unavailable (no infinite loop)", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "candidates",
      candidates: TEN_CANDIDATES,
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch("body care");

    const sheet = await screen.findByTestId("search-suggest-sheet");
    fireEvent.click(within(sheet).getByTestId("search-suggest-none"));
    await waitFor(() =>
      expect(within(sheet).getAllByTestId("search-suggest-option")).toHaveLength(10),
    );
    fireEvent.click(within(sheet).getByTestId("search-suggest-none"));

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        strings.en.search_category_unavailable,
        { duration: 4000 },
      ),
    );
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
    expect(mocks.classifySearchTermForRadar).toHaveBeenCalledTimes(1);
  });

  it("no-confident-match fallback shows growth unavailable message, not browse-below", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "fallback",
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch("shoe repair");

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        strings.en.search_category_unavailable,
        { duration: 4000 },
      ),
    );
    expect(mocks.toastInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("browsing categories"),
      expect.anything(),
    );
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
  });

  it("government-service hint still toasts on Home without navigating", async () => {
    mocks.classifySearchTermForRadar.mockResolvedValue({
      outcome: "hint",
      message: "Search for Ambulance, Doctor, or Nursing instead",
    } satisfies ClassifySearchForRadarResult);

    await renderHome();
    await submitSearch("hospital nearby");

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        "Search for Ambulance, Doctor, or Nursing instead",
      ),
    );
    expect(screen.queryByTestId("search-suggest-sheet")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
