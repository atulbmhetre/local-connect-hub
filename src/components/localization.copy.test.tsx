import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { strings, type Language, t } from "@/lib/strings";
import { NotificationBell } from "@/components/NotificationBell";
import { GovEmergencyServices } from "@/pages/RadarSearch";
import { ParchiSheet } from "@/components/ParchiSheet";
import type { Vendor } from "@/lib/supabase";
import { formatHelpDelayedWarning } from "@/lib/orderHelpDelay";
import { toast } from "sonner";

function setTestLang(lang: Language) {
  (globalThis as { __testLang?: Language }).__testLang = lang;
}

function mockLanguage() {
  const lang = (globalThis as { __testLang?: Language }).__testLang ?? "en";
  return { s: strings[lang], lang, setLang: () => {} };
}

vi.mock("@/lib/language", () => ({
  useLanguage: () => mockLanguage(),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: {
      maxOrderMessageChars: 500,
      helpAcceptTimeoutHours: 5,
      khataAmberLimit: 0,
      khataRedLimit: 0,
    },
    loading: false,
  }),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
  isPhoneKnown: () => true,
  USER_PHONE_CHANGED_EVENT: "aaspaas:user_phone_changed",
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "device-test",
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/vendor", search: "", hash: "", state: null, key: "test" }),
}));

vi.mock("@/lib/notificationNavigation", () => ({
  navigateFromNotification: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

const mockSupabase = vi.hoisted(() => {
  const rpc = vi.fn().mockResolvedValue({ data: "order-1", error: null });
  const chain = {
    select: vi.fn(function select() {
      return chain;
    }),
    eq: vi.fn(function eq() {
      return chain;
    }),
    is: vi.fn(async () => ({ count: 0, error: null })),
    in: vi.fn(function inn() {
      return chain;
    }),
    order: vi.fn(function order() {
      return chain;
    }),
    limit: vi.fn(async () => ({ data: [], error: null, count: 0 })),
    delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    update: vi.fn(() => {
      const updateChain = {
        eq: vi.fn(function eq() {
          return updateChain;
        }),
        then: (cb: (r: { error: null }) => void) => {
          cb({ error: null });
          return Promise.resolve({ error: null });
        },
      };
      return updateChain;
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  return {
    from: vi.fn(() => chain),
    rpc,
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  };
});

vi.mock("@/hooks/useUserAddresses", () => ({
  useUserAddresses: () => ({ addresses: [], loading: false }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: mockSupabase,
  fetchUserTrust: vi.fn(),
  invokeNotifyVendor: vi.fn(),
  upsertUser: vi.fn(),
  incrementUserOrders: vi.fn(),
  invokecalculateTrustScore: vi.fn(),
  invokeNotifyUser: vi.fn(),
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "test",
}));

function assertLocalizedNotEnglish(lang: Language, english: string, localized: string) {
  render(<span data-testid="copy">{localized}</span>);
  expect(screen.getByTestId("copy")).toHaveTextContent(localized);
  expect(screen.queryByText(english)).not.toBeInTheDocument();
}

describe("localization copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const lang of ["hi", "mr"] as const) {
    it(`notif_bell_empty_title (${lang})`, async () => {
      setTestLang(lang);
      render(<NotificationBell />);
      fireEvent.click(screen.getByLabelText(strings[lang].notif_bell_aria_label));
      await waitFor(() => {
        expect(screen.getByText(strings[lang].notif_bell_empty_title)).toBeInTheDocument();
      });
      expect(screen.queryByText(strings.en.notif_bell_empty_title)).not.toBeInTheDocument();
    });

    it(`radar_gov_fire_label (${lang})`, () => {
      setTestLang(lang);
      render(<GovEmergencyServices term="Fire Brigade" defaultOpen />);
      expect(screen.getByText(strings[lang].radar_gov_fire_label)).toBeInTheDocument();
      expect(screen.queryByText(strings.en.radar_gov_fire_label)).not.toBeInTheDocument();
    });

    it(`warn_user_title (${lang})`, () => {
      assertLocalizedNotEnglish(lang, strings.en.warn_user_title, t(lang, "warn_user_title"));
    });

    it(`parchi_trust_low_title (${lang})`, () => {
      setTestLang(lang);
      const vendor = {
        id: "vendor-1",
        name: "Test",
        shop_name: "Test Shop",
        category: "Grocery",
        upi_id: "test@upi",
        phone: "9999999999",
        is_active: true,
        latitude: 18.5,
        longitude: 73.8,
        verification_status: "unverified",
        shop_photo_url: null,
        upi_verified: false,
        is_manual_verified: false,
        created_at: new Date().toISOString(),
        service_mode: "delivery",
        cancel_reason_1: null,
        cancel_reason_2: null,
        cancel_reason_3: null,
        cancel_reason_4: null,
        service_radius_km: 15,
      } as Vendor;
      render(<ParchiSheet vendor={vendor} isOpen onClose={() => {}} />);
      expect(screen.queryByText(strings.en.parchi_trust_low_title)).not.toBeInTheDocument();
    });

    it(`incoming_flag_submit (${lang})`, () => {
      assertLocalizedNotEnglish(
        lang,
        strings.en.incoming_flag_submit,
        strings[lang].incoming_flag_submit,
      );
    });

    it(`vendor_radius_save_error (${lang})`, () => {
      setTestLang(lang);
      toast.error(strings[lang].vendor_radius_save_error);
      expect(toast.error).toHaveBeenCalledWith(strings[lang].vendor_radius_save_error);
      expect(strings[lang].vendor_radius_save_error).not.toBe(strings.en.vendor_radius_save_error);
    });
  }

  it("order_help_delayed_warning uses configured hours not placeholder", () => {
    const rendered = formatHelpDelayedWarning(
      strings.en.order_help_delayed_warning,
      5,
    );
    expect(rendered).toContain("5");
    expect(rendered).not.toContain("{hours}");
  });

  it.each(["hi", "mr"] as const)("Home discovery entry copy is localized (%s)", (lang) => {
    const keys = [
      "home_voice_unavailable",
      "home_voice_search_aria",
      "home_sos_aria",
      "home_saved_vendor_sheet_description",
      "home_saved_neighbours_load_error",
      "home_categories_load_error",
      "home_active_orders_load_error",
      "home_help_banner_load_error",
      "online",
      "vendor_referLinkCopied",
      "home_suggest_title",
      "home_suggest_you_searched",
      "home_suggest_none",
      "home_suggest_rephrase_prompt",
      "home_suggest_rephrase_placeholder",
      "home_suggest_rephrase_submit",
    ] as const;

    for (const key of keys) {
      expect(strings[lang][key]).toBeTruthy();
      expect(strings[lang][key]).not.toBe(strings.en[key]);
    }
  });
});
