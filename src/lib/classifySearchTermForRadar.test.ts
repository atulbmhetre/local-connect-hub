import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GATEWAY = "https://example.supabase.co/functions/v1/ai-gateway";

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "unit-device" }));

vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-test-key");

describe("classifySearchTermForRadar", () => {
  let classifySearchTermForRadar: typeof import("@/lib/supabase").classifySearchTermForRadar;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ({ classifySearchTermForRadar } = await import("@/lib/supabase"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cats = [
    {
      id: "1",
      label: "Plumber",
      emoji: "🚰",
      service_mode: "help" as const,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "2",
      label: "Security",
      emoji: "🛡️",
      service_mode: "help" as const,
      is_active: true,
      sort_order: 2,
    },
  ];

  it("returns exact for a case-insensitive DB label match and never calls the gateway", async () => {
    const r = await classifySearchTermForRadar("plumber", cats);
    expect(r).toEqual({ outcome: "exact", query: "Plumber" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns candidates from the gateway, never an auto-accepted single guess", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: {
          candidates: [
            { label: "Security", emoji: "🛡️", mode: "help" },
            { label: "Nursing", emoji: "🩺", mode: "help" },
          ],
        },
      }),
    });

    const r = await classifySearchTermForRadar(
      "I am lost and need someone to help me find the way out",
      cats,
    );
    expect(r).toEqual({
      outcome: "candidates",
      candidates: [
        { label: "Security", emoji: "🛡️", mode: "help" },
        { label: "Nursing", emoji: "🩺", mode: "help" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "classify_category",
          term: "I am lost and need someone to help me find the way out",
        }),
      }),
    );
  });

  it("returns hint for a government-service response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: {
          candidates: [],
          is_government: true,
          message: "Search for Ambulance, Doctor, or Nursing instead",
        },
      }),
    });

    const r = await classifySearchTermForRadar("hospital", cats);
    expect(r).toEqual({
      outcome: "hint",
      message: "Search for Ambulance, Doctor, or Nursing instead",
    });
  });

  it("falls back when the gateway returns an empty candidate list (no Other path)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: { candidates: [], canonical: "Other" },
      }),
    });

    const r = await classifySearchTermForRadar("xyzzy unrelated nonsense", cats);
    expect(r).toEqual({ outcome: "fallback" });
  });

  it("falls back on gateway HTTP failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const r = await classifySearchTermForRadar("anything", cats);
    expect(r).toEqual({ outcome: "fallback" });
  });
});
