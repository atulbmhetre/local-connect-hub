import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildRecommendedVendorRadarUrl,
  resolveRecommendedVendorRadarLink,
} from "@/lib/feedVendorLink";

const { vendorRow } = vi.hoisted(() => ({
  vendorRow: {
    data: { is_active: true, category: "Plumber" } as
      | { is_active: boolean; category: string }
      | null,
    error: null as { message: string } | null,
  },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn(async () => (table === "vendors" ? vendorRow : { data: null, error: null })),
      };
      return chain;
    },
  },
}));

describe("feed recommended vendor radar link", () => {
  beforeEach(() => {
    vendorRow.data = { is_active: true, category: "Plumber" };
    vendorRow.error = null;
  });

  it("buildRecommendedVendorRadarUrl uses vendor service_mode not hardcoded delivery", () => {
    expect(buildRecommendedVendorRadarUrl("Plumber", "appointment")).toBe(
      "/radar?q=Plumber&mode=appointment",
    );
    expect(buildRecommendedVendorRadarUrl("Kirana", "help")).toBe(
      "/radar?q=Kirana&mode=help",
    );
  });

  it("offline help vendor is flagged offline", async () => {
    vendorRow.data = { is_active: false, category: "Helper" };
    const result = await resolveRecommendedVendorRadarLink("v1", "help");
    expect(result).toEqual({ ok: false, offline: true });
  });

  it("offline appointment vendor still resolves category", async () => {
    vendorRow.data = { is_active: false, category: "Salon" };
    const result = await resolveRecommendedVendorRadarLink("v1", "appointment");
    expect(result).toEqual({ ok: true, categoryLabel: "Salon" });
  });
});
