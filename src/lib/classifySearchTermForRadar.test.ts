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
  }, 30_000);

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
    {
      id: "3",
      label: "Mechanic",
      emoji: "🔧",
      service_mode: "help" as const,
      is_active: true,
      sort_order: 3,
    },
    {
      id: "4",
      label: "Grocery Store",
      emoji: "🛒",
      service_mode: "delivery" as const,
      is_active: true,
      sort_order: 4,
    },
  ];

  it("returns exact for a case-insensitive DB label match and never calls the gateway", async () => {
    const r = await classifySearchTermForRadar("plumber", cats);
    expect(r).toEqual({ outcome: "exact", query: "Plumber", mode: "help" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["mechanic", "Mechanic", "help"],
    ["bike mechanic", "Mechanic", "help"],
    ["I am looking for bike mechanic", "Mechanic", "help"],
    ["mikanik", "Mechanic", "help"],
    ["kirana", "Grocery Store", "delivery"],
  ] as const)(
    "alias pre-pass resolves %j to %j without calling ai-gateway",
    async (query, expectedLabel, mode) => {
      const r = await classifySearchTermForRadar(query, cats);
      expect(r).toEqual({ outcome: "exact", query: expectedLabel, mode });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("Phase 7: multi exact aliases navigate with original term (not Did-you-mean sheet)", async () => {
    const { setCategorySearchTermsCacheForTests } = await import(
      "@/lib/categorySearchTerms"
    );
    setCategorySearchTermsCacheForTests([
      {
        category_id: "id-dairy",
        term: "testmilk",
        label: "Dairy",
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      },
      {
        category_id: "id-grocery",
        term: "testmilk",
        label: "Grocery Store",
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      },
    ]);
    const multiCats = [
      ...cats,
      {
        id: "id-dairy",
        label: "Dairy",
        emoji: "🥛",
        service_mode: "delivery" as const,
        is_active: true,
        sort_order: 10,
      },
    ];
    const r = await classifySearchTermForRadar("testmilk", multiCats);
    expect(r).toEqual({ outcome: "exact", query: "testmilk", mode: "delivery" });
    expect(fetchMock).not.toHaveBeenCalled();
    setCategorySearchTermsCacheForTests(null);
  });

  it("falls through to AI when alias resolves but label is not in active DB categories", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: { candidates: [], no_confident_match: true },
      }),
    });
    const withoutMechanic = cats.filter((c) => c.label !== "Mechanic");
    const r = await classifySearchTermForRadar("bike mechanic", withoutMechanic);
    expect(r).toEqual({ outcome: "fallback" });
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("ai-gateway")),
    ).toHaveLength(1);
  });

  it("returns candidates from the gateway when confidence clears the gate", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: {
          candidates: [
            { label: "Security", emoji: "🛡️", mode: "help" },
            { label: "Nursing", emoji: "🩺", mode: "help" },
          ],
          confidence: 0.92,
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

  it("returns fallback when gateway reports no_confident_match", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: { candidates: [], no_confident_match: true },
      }),
    });

    const r = await classifySearchTermForRadar("shoe repair cobbler", cats);
    expect(r).toEqual({ outcome: "fallback" });
  });

  it("returns fallback when confidence is below the client gate even if candidates exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: {
          candidates: [{ label: "Mechanic", emoji: "🔧", mode: "help" }],
          confidence: 0.4,
        },
      }),
    });

    const r = await classifySearchTermForRadar("shoe repair", cats);
    expect(r).toEqual({ outcome: "fallback" });
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
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("ai-gateway")),
    ).toHaveLength(1);
  });

  it("still invokes ai-gateway for queries with no alias or DB match", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        action: "classify_category",
        result: { candidates: [], no_confident_match: true },
      }),
    });

    const r = await classifySearchTermForRadar("quantum plasma widget repair", cats);
    expect(r).toEqual({ outcome: "fallback" });
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("ai-gateway")),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "classify_category",
          term: "quantum plasma widget repair",
        }),
      }),
    );
  });

  it("Phase 6: typo fuzzy hits return candidates (Did you mean), never silent exact", async () => {
    const r = await classifySearchTermForRadar("mecanik", cats);
    expect(r.outcome).toBe("candidates");
    if (r.outcome === "candidates") {
      expect(r.candidates.some((c) => c.label === "Mechanic")).toBe(true);
    }
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("ai-gateway")),
    ).toBe(false);
  });

  it("Phase 6: electrisian / plumer fuzzy → candidates only", async () => {
    const e = await classifySearchTermForRadar("electrisian", [
      ...cats,
      {
        id: "5",
        label: "Electrician",
        emoji: "💡",
        service_mode: "help" as const,
        is_active: true,
        sort_order: 5,
      },
    ]);
    expect(e.outcome).toBe("candidates");
    if (e.outcome === "candidates") {
      expect(e.candidates.some((c) => c.label === "Electrician")).toBe(true);
    }

    const p = await classifySearchTermForRadar("plumer", cats);
    expect(p.outcome).toBe("candidates");
    if (p.outcome === "candidates") {
      expect(p.candidates.some((c) => c.label === "Plumber")).toBe(true);
    }
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("ai-gateway")),
    ).toBe(false);
  });

  it("falls back on gateway HTTP failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const r = await classifySearchTermForRadar("anything", cats);
    expect(r).toEqual({ outcome: "fallback" });
  });
});
