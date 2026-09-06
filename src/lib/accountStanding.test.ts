import { describe, expect, it } from "vitest";
import { resolveAccountStanding } from "./accountStanding";

const labels = {
  trust_status_loading: "loading",
  trust_status_unavailable: "unavailable",
  trust_status_good: "good",
  trust_status_fair: "fair",
  trust_status_complaints: "complaints",
  trust_status_banned: "banned",
};

describe("resolveAccountStanding", () => {
  it("shows loading while trust is still null and fetch is in flight", () => {
    expect(
      resolveAccountStanding({
        loading: true,
        loadFailed: false,
        userTrust: null,
        labels,
      }),
    ).toEqual({ tone: "loading", label: "loading" });
  });

  it("shows unavailable on RPC failure", () => {
    expect(
      resolveAccountStanding({
        loading: false,
        loadFailed: true,
        userTrust: null,
        labels,
      }),
    ).toEqual({ tone: "unavailable", label: "unavailable" });
  });

  it("treats successful empty row as good standing", () => {
    expect(
      resolveAccountStanding({
        loading: false,
        loadFailed: false,
        userTrust: null,
        labels,
      }),
    ).toEqual({ tone: "good", label: "good" });
  });

  it("maps banned / fair / complaints from trust fields", () => {
    expect(
      resolveAccountStanding({
        loading: false,
        loadFailed: false,
        userTrust: { trust_score: 80, warn_count: 0, is_banned: true },
        labels,
      }).tone,
    ).toBe("banned");
    expect(
      resolveAccountStanding({
        loading: false,
        loadFailed: false,
        userTrust: { trust_score: 50, warn_count: 0, is_banned: false },
        labels,
      }).tone,
    ).toBe("fair");
    expect(
      resolveAccountStanding({
        loading: false,
        loadFailed: false,
        userTrust: { trust_score: 10, warn_count: 0, is_banned: false },
        labels,
      }).tone,
    ).toBe("complaints");
  });
});
