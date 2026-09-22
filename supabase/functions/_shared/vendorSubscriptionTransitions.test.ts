import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  shouldSkipGraceToExpired,
  shouldSkipTrialToGrace,
  vendorEffectiveTrialEnd,
} from "./vendorSubscriptionTransitions";

const CREATED = new Date("2026-01-15T10:30:00.000Z");

describe("vendorEffectiveTrialEnd", () => {
  it("adds trial days and pause credit in UTC milliseconds, not calendar dates", () => {
    const end = vendorEffectiveTrialEnd({
      createdAt: CREATED,
      vendorTrialDays: 30,
      pauseCreditDays: 7,
    });
    expect(end.toISOString()).toBe(addUtcDays(CREATED, 37).toISOString());
    expect(end.getTime() - CREATED.getTime()).toBe(37 * 86_400_000);
  });

  it("matches created_at + 30d when credit is 0", () => {
    const end = vendorEffectiveTrialEnd({
      createdAt: "2026-01-15T10:30:00.000Z",
      vendorTrialDays: 30,
      pauseCreditDays: 0,
    });
    expect(end.toISOString()).toBe("2026-02-14T10:30:00.000Z");
  });
});

describe("shouldSkipTrialToGrace", () => {
  const trialDays = 30;
  const trialEnd = addUtcDays(CREATED, trialDays);

  it("skips while an open billing window exists even after trial elapsed", () => {
    expect(
      shouldSkipTrialToGrace({
        now: addUtcDays(trialEnd, 2),
        createdAt: CREATED,
        vendorTrialDays: trialDays,
        pauseCreditDays: 0,
        globalBillingStart: null,
        hasOpenBillingWindow: true,
      }),
    ).toBe(true);
  });

  it("skips before the effective trial end (including pause credit)", () => {
    expect(
      shouldSkipTrialToGrace({
        now: addUtcDays(CREATED, 32),
        createdAt: CREATED,
        vendorTrialDays: trialDays,
        pauseCreditDays: 7,
        globalBillingStart: null,
        hasOpenBillingWindow: false,
      }),
    ).toBe(true);
  });

  it("does not skip after effective trial end when no window and billing has started", () => {
    expect(
      shouldSkipTrialToGrace({
        now: addUtcDays(CREATED, 38),
        createdAt: CREATED,
        vendorTrialDays: trialDays,
        pauseCreditDays: 7,
        globalBillingStart: null,
        hasOpenBillingWindow: false,
      }),
    ).toBe(false);
  });

  it("skips when now is before global_billing_start_date", () => {
    expect(
      shouldSkipTrialToGrace({
        now: addUtcDays(CREATED, 40),
        createdAt: CREATED,
        vendorTrialDays: trialDays,
        pauseCreditDays: 0,
        globalBillingStart: addUtcDays(CREATED, 50),
        hasOpenBillingWindow: false,
      }),
    ).toBe(true);
  });
});

describe("shouldSkipGraceToExpired", () => {
  const graceEnds = new Date("2026-03-01T06:00:00.000Z");

  it("skips while an open billing window exists even after grace_ends_at", () => {
    expect(
      shouldSkipGraceToExpired({
        now: addUtcDays(graceEnds, 1),
        graceEndsAt: graceEnds,
        hasOpenBillingWindow: true,
      }),
    ).toBe(true);
  });

  it("skips before grace_ends_at", () => {
    expect(
      shouldSkipGraceToExpired({
        now: new Date(graceEnds.getTime() - 1),
        graceEndsAt: graceEnds.toISOString(),
        hasOpenBillingWindow: false,
      }),
    ).toBe(true);
  });

  it("does not skip at or after grace_ends_at without an open window", () => {
    expect(
      shouldSkipGraceToExpired({
        now: graceEnds,
        graceEndsAt: graceEnds,
        hasOpenBillingWindow: false,
      }),
    ).toBe(false);
  });
});
