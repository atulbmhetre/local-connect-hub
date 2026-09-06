import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Settings Help & Support row placement", () => {
  it("places help link after Connection & Privacy / legal links, before Clear My Data", () => {
    const src = readFileSync(resolve(__dirname, "Settings.tsx"), "utf8");
    const privacy = src.indexOf('data-testid="settings-privacy-policy-link"');
    const terms = src.indexOf('data-testid="settings-terms-of-service-link"');
    const help = src.indexOf('data-testid="settings-help-support-link"');
    const clearData = src.indexOf("settings_clearMyData");
    const notifBell = src.indexOf("NotificationBell");

    expect(privacy).toBeGreaterThan(-1);
    expect(terms).toBeGreaterThan(privacy);
    expect(help).toBeGreaterThan(terms);
    expect(clearData).toBeGreaterThan(help);
    // Help must sit in the bottom zone, not beside the notifications bell in the header.
    expect(help).toBeGreaterThan(notifBell);
  });
});
