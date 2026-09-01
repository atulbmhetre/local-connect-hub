import { describe, expect, it, vi } from "vitest";
import { requestAadhaarDigilockerConsent } from "./aadhaarDigilocker";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

import { supabase } from "@/lib/supabase";

describe("requestAadhaarDigilockerConsent", () => {
  it("does not invoke the edge function when the app_config flag is off", async () => {
    const result = await requestAadhaarDigilockerConsent({
      enabled: false,
      vendorPhone: "9900012345",
    });
    expect(result).toEqual({ ok: false, reason: "dormant" });
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });
});
