import { describe, expect, it, vi, afterEach } from "vitest";
import { formatHelpDelayedWarning, isHelpAcceptDelayed } from "@/lib/orderHelpDelay";

describe("order help delayed warning", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("isHelpAcceptDelayed is false before timeout hours elapse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    const createdAt = "2026-06-16T11:30:00Z";
    expect(isHelpAcceptDelayed(createdAt, createdAt, 2)).toBe(false);
  });

  it("isHelpAcceptDelayed is true after timeout hours elapse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T14:01:00Z"));
    const createdAt = "2026-06-16T12:00:00Z";
    expect(isHelpAcceptDelayed(null, createdAt, 2)).toBe(true);
  });

  it("formatHelpDelayedWarning substitutes configured hours not literal placeholder", () => {
    const template = "Waited over {hours} hours for vendor response.";
    expect(formatHelpDelayedWarning(template, 4)).toBe(
      "Waited over 4 hours for vendor response.",
    );
    expect(formatHelpDelayedWarning(template, 4)).not.toContain("{hours}");
  });
});
