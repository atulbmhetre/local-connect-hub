import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { strings } from "@/lib/strings";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { getUserPhone } from "@/lib/userIdentity";

const { mockUsersData, mockVendorStatus, mockRpc } = vi.hoisted(() => {
  let usersData: { total_orders: number; is_banned?: boolean } | null = null;
  let vendorStatus: {
    found: boolean;
    vendor_id: string | null;
    is_banned?: boolean;
    restore_allowed?: boolean;
    deny_reason?: string | null;
  } | null = null;

  const rpc = vi.fn(async (fnName: string) => {
    if (fnName === "lookup_user_by_phone") {
      return usersData ? { data: [usersData], error: null } : { data: [], error: null };
    }
    if (fnName === "get_vendor_restore_status") {
      return {
        data: vendorStatus ?? {
          found: false,
          vendor_id: null,
          is_banned: false,
          restore_allowed: false,
          deny_reason: "not_found",
        },
        error: null,
      };
    }
    if (
      fnName === "migrate_saved_vendors_phone" ||
      fnName === "migrate_device_requests_phone" ||
      fnName === "ensure_user_device_link"
    ) {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  return {
    mockUsersData: {
      set: (v: { total_orders: number; is_banned?: boolean } | null) => {
        usersData = v;
      },
    },
    mockVendorStatus: {
      set: (
        v: {
          found: boolean;
          vendor_id: string | null;
          restore_allowed?: boolean;
          deny_reason?: string | null;
        } | null,
      ) => {
        vendorStatus = v;
      },
    },
    mockRpc: rpc,
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: mockRpc },
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "phone-entry-device",
}));

vi.mock("@/lib/sentry", () => ({
  captureError: vi.fn(),
}));

vi.mock("@/lib/referral", () => ({
  recordUserReferral: vi.fn(async () => {}),
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

describe("PhoneEntrySheet existing-account safety net", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsersData.set(null);
    mockVendorStatus.set(null);
    vi.clearAllMocks();
  });

  it("offers restore when a new-path customer later enters a known phone", async () => {
    const onConfirmed = vi.fn();
    mockUsersData.set({ total_orders: 4 });

    render(
      <PhoneEntrySheet
        isOpen
        onClose={() => {}}
        onConfirmed={onConfirmed}
        context="order"
        skipRecovery
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(strings.en.phone_entry_placeholder), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.en.phone_entry_continue }));

    await waitFor(() => {
      expect(screen.getByTestId("phone-entry-existing-title")).toHaveTextContent(
        strings.en.firstopen_existing_title,
      );
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("get_vendor_restore_status", {
      p_phone: "9876543210",
    });

    fireEvent.click(screen.getByTestId("phone-entry-existing-restore"));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith("9876543210"));
    expect(getUserPhone()).toBe("9876543210");
  });

  it("detects vendor-only history via get_vendor_restore_status", async () => {
    mockVendorStatus.set({
      found: true,
      vendor_id: "v-safety-1",
      restore_allowed: true,
      deny_reason: null,
    });

    render(
      <PhoneEntrySheet isOpen onClose={() => {}} onConfirmed={vi.fn()} skipRecovery />,
    );

    fireEvent.change(screen.getByPlaceholderText(strings.en.phone_entry_placeholder), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.en.phone_entry_continue }));

    await waitFor(() => {
      expect(screen.getByTestId("phone-entry-existing-restore")).toBeInTheDocument();
    });
  });
});
