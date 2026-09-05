import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppNotifyContact } from "./appNotifyLead";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mocks.rpc },
}));

describe("parseAppNotifyContact", () => {
  it("accepts a 10-digit Indian mobile", () => {
    expect(parseAppNotifyContact("9876543210")).toEqual({
      ok: true,
      contact: "9876543210",
      kind: "phone",
    });
  });

  it("strips +91 and spaces from a mobile", () => {
    expect(parseAppNotifyContact("+91 98765 43210")).toEqual({
      ok: true,
      contact: "9876543210",
      kind: "phone",
    });
  });

  it("strips a bare 91 country prefix (12 digits)", () => {
    expect(parseAppNotifyContact("919876543210")).toEqual({
      ok: true,
      contact: "9876543210",
      kind: "phone",
    });
  });

  it("rejects a landline-style number", () => {
    expect(parseAppNotifyContact("0221234567")).toEqual({ ok: false });
  });

  it("accepts and lowercases email", () => {
    expect(parseAppNotifyContact("  Ada@Example.com ")).toEqual({
      ok: true,
      contact: "ada@example.com",
      kind: "email",
    });
  });

  it("rejects a bare word with no @", () => {
    expect(parseAppNotifyContact("not-an-email")).toEqual({ ok: false });
  });

  it("rejects blank input", () => {
    expect(parseAppNotifyContact("   ")).toEqual({ ok: false });
  });
});

describe("submitAppNotifyLead", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("rpc-submits a normalized email", async () => {
    const { submitAppNotifyLead } = await import("./appNotifyLead");
    const result = await submitAppNotifyLead("  Ada@Example.com ");
    expect(result).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("submit_app_notify_lead", {
      p_contact: "ada@example.com",
    });
  });

  it("skips the rpc for invalid input", async () => {
    const { submitAppNotifyLead } = await import("./appNotifyLead");
    const result = await submitAppNotifyLead("nope");
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps rpc false to invalid", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const { submitAppNotifyLead } = await import("./appNotifyLead");
    await expect(submitAppNotifyLead("9876543210")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("does not treat a missing RPC as success", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "Could not find the function", code: "PGRST202" },
    });
    const { submitAppNotifyLead } = await import("./appNotifyLead");
    await expect(submitAppNotifyLead("9876543210")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("does not treat a null payload as success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const { submitAppNotifyLead } = await import("./appNotifyLead");
    await expect(submitAppNotifyLead("notify@example.com")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
