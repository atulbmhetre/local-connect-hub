import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { strings } from "@/lib/strings";

const {
  mockFetchVendorOwn,
  mockPatchVendorOwn,
  mockRpc,
  mockFrom,
  mockChannel,
  captureErrorMock,
} = vi.hoisted(() => ({
  mockFetchVendorOwn: vi.fn(),
  mockPatchVendorOwn: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockChannel: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({
  captureError: captureErrorMock,
  toCapturedError: (e: unknown) => e,
}));

vi.mock("@/lib/vendorRead", () => ({
  fetchVendorOwn: (...args: unknown[]) => mockFetchVendorOwn(...args),
  fetchVendorByPhoneLogin: vi.fn(),
}));

vi.mock("@/lib/vendorPatch", () => ({
  patchVendorOwn: (...args: unknown[]) => mockPatchVendorOwn(...args),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    channel: (...args: unknown[]) => mockChannel(...args),
    removeChannel: vi.fn(),
  },
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "test",
  SHOP_PHOTOS_BUCKET: "shop",
  VENDOR_SELFIES_BUCKET: "selfies",
  GPS_MATCH_TOLERANCE_M: 100,
  isValidPhone: () => true,
  isValidUpi: () => true,
  distanceMeters: () => 0,
  useCategoryLabel: () => (id: string) => id,
  useServiceModeLabel: () => (m: string) => m,
  invokeRegisterVendor: vi.fn(),
  invokeSuggestCategory: vi.fn(),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9000000001",
  saveUserPhone: vi.fn(),
  getAuthSessionPhone: () => null,
  sessionPhoneMatchesVendor: () => true,
}));

vi.mock("@/lib/phoneOtpEnabled", () => ({
  OTP_ENABLED: false,
  normalizePhoneDigits: (p: string) => p,
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({ config: {}, loading: false }),
}));

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/PhoneOtpVerification", () => ({
  PhoneOtpVerification: () => null,
}));

vi.mock("@/components/TrustBadge", () => ({
  TrustBadge: () => null,
}));

vi.mock("@/lib/referral", () => ({
  getReferralCode: () => null,
  isReferralEnabled: async () => false,
  referralCodeFromPhone: () => "",
}));

vi.mock("@/lib/vendorBackgroundLocation", () => ({
  startHelpLiveTracking: vi.fn(),
  stopHelpLiveTracking: vi.fn(),
}));

vi.mock("@/lib/pushNotifications", () => ({
  registerPushToken: vi.fn(),
}));

vi.mock("@/lib/vendorActiveFlag", () => ({
  reconcileVendorActiveFlag: vi.fn(),
}));

vi.mock("@/lib/vendorSessionSync", () => ({
  notifyVendorIdChanged: vi.fn(),
  reconcileVendorActiveFlag: vi.fn(),
}));

vi.mock("@/components/IncomingOrdersSection", () => ({
  IncomingOrdersSection: () => null,
}));

vi.mock("@/components/vendor/VendorAnalytics", () => ({
  VendorAnalytics: () => null,
}));

vi.mock("@/components/VendorOnboarding", () => ({
  VendorOnboarding: () => null,
  isVendorOnboardingComplete: () => true,
}));

vi.mock("@/components/vendor/VendorRegistrationWizard", () => ({
  VendorRegistrationWizard: () => null,
}));

vi.mock("@/components/NetworkErrorBanner", () => ({
  NetworkErrorBanner: () => null,
}));

vi.mock("@/components/NotificationBell", () => ({
  NotificationBell: () => null,
}));

vi.mock("@/lib/vendorGreenReady", () => ({
  checkAndNotifyAdminGreenReady: vi.fn(),
}));

vi.mock("@/lib/nativePermissions", () => ({
  ensureNativePermission: vi.fn(),
  isPermissionGranted: () => true,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/hooks/useNetworkStatus", () => ({
  getNavigatorOnline: () => true,
}));

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast: vi.fn(),
  showNetworkFailedToast: vi.fn(),
  dismissNetworkRetryingToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  }),
}));

import VendorMode from "@/pages/VendorMode";

const VENDOR = {
  id: "vendor-1",
  name: "Test Vendor",
  shop_name: "Test Shop",
  category: "Grocery",
  upi_id: "shop@upi",
  phone: "9000000001",
  is_active: false,
  is_banned: false,
  latitude: 18.5,
  longitude: 73.8,
  verification_status: "unverified",
  shop_photo_url: "https://example.com/shop.jpg",
  photo_selfie: "https://example.com/selfie.jpg",
  upi_verified: false,
  is_manual_verified: false,
  created_at: new Date().toISOString(),
  service_mode: "delivery",
  subscription_active: true,
  trial_ends_at: null,
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  service_radius_km: 15,
};

describe("VendorMode go-live sync lock", () => {
  beforeAll(() => {
    localStorage.setItem("aaspaas:vendor_id", "vendor-1");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchVendorOwn.mockResolvedValue({ data: VENDOR, error: null });
    mockPatchVendorOwn.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: undefined,
    });
    mockChannel.mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    });
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it("rapid double-tap on go-live calls patchVendorOwn only once", async () => {
    let resolvePatch: (() => void) | undefined;
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });

    mockPatchVendorOwn.mockImplementation(async () => {
      await patchGate;
      return { error: null };
    });

    render(
      <MemoryRouter>
        <VendorMode />
      </MemoryRouter>,
    );

    const btn = await screen.findByTestId("vendor-golive-btn");
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockPatchVendorOwn).toHaveBeenCalledTimes(1);
    });

    resolvePatch?.();
    await waitFor(() => {
      expect(mockPatchVendorOwn).toHaveBeenCalledTimes(1);
    });
  });

  it("unknown go-live patchVendorOwn failure calls captureError", async () => {
    const err = { message: "unexpected_golive_rpc_failure" };
    mockPatchVendorOwn.mockResolvedValue({ error: err });

    render(
      <MemoryRouter>
        <VendorMode />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("vendor-golive-btn"));

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          scope: "vendorMode.applyActiveState",
          vendorId: "vendor-1",
          goingLive: true,
        }),
      );
    });
  });

  it("vendor_photos_required go-live failure does not call captureError", async () => {
    mockPatchVendorOwn.mockResolvedValue({
      error: { message: "vendor_photos_required" },
    });

    render(
      <MemoryRouter>
        <VendorMode />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("vendor-golive-btn"));

    await waitFor(() => {
      expect(mockPatchVendorOwn).toHaveBeenCalled();
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("vendor_banned go-live failure does not call captureError", async () => {
    mockPatchVendorOwn.mockResolvedValue({
      error: { message: "vendor_banned" },
    });

    render(
      <MemoryRouter>
        <VendorMode />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("vendor-golive-btn"));

    await waitFor(() => {
      expect(mockPatchVendorOwn).toHaveBeenCalled();
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
