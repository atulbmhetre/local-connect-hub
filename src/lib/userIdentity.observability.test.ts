import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureErrorMock, rpcMock } = vi.hoisted(() => ({
  captureErrorMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({
  captureError: captureErrorMock,
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "obs-device",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: rpcMock,
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

import { ensureUserDeviceLink, migrateUserPhone } from "@/lib/userIdentity";

describe("userIdentity captureError wiring", () => {
  beforeEach(() => {
    captureErrorMock.mockClear();
    rpcMock.mockReset();
  });

  it("captureError on ensure_user_device_link failure", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "link_boom" } });
    await ensureUserDeviceLink("9876543210");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "link_boom" }),
      expect.objectContaining({ scope: "userIdentity.ensureUserDeviceLink" }),
    );
  });

  it("captureError on migrate_device_requests_phone failure", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "req_boom" } });
    await migrateUserPhone("9876543210", "obs-device");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "req_boom" }),
      expect.objectContaining({ scope: "userIdentity.migrateUserPhone.requests" }),
    );
  });
});
