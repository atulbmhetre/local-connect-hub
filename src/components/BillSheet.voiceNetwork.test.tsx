import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BillSheet } from "@/components/BillSheet";
import { strings } from "@/lib/strings";

const { mockRpc, mockFrom, toastError } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mockRpc,
    from: mockFrom,
  },
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9000000001",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/nativePermissions", () => ({
  ensureVoiceMicrophone: async () => true,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    available: async () => ({ available: true }),
    start: async () => ({ matches: ["two chai 20 rupees"] }),
  },
}));

vi.mock("@/components/BillMenuCatalogPicker", () => ({
  BillMenuCatalogPicker: () => null,
}));

describe("BillSheet voice-bill network failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { items: null, service_mode: "help" },
            error: null,
          }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_vendor_order_bills") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });
  });

  it("shows voice_failed toast when parse-voice-bill fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    render(
      <BillSheet
        isOpen
        onClose={() => {}}
        requestId="req-1"
        vendorId="vendor-1"
        userPhone="9876543210"
        shopName="Test Shop"
        khataAmberLimit={0}
        khataRedLimit={0}
      />,
    );

    const voiceBtn = await screen.findByRole("button", {
      name: strings.en.bill_voicePrompt,
    });
    fireEvent.click(voiceBtn);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(strings.en.voice_failed);
    });
  });
});
