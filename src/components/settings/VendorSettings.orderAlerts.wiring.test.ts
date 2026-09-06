import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("VendorSettings Order Alerts native gate", () => {
  const src = readFileSync(
    resolve(__dirname, "VendorSettings.tsx"),
    "utf8",
  );

  it("mounts Order Alerts only behind Capacitor.isNativePlatform()", () => {
    expect(src).toContain('testId="settings-order-alerts-toggle"');
    expect(src).toContain("settings_order_alerts");
    expect(src).toMatch(
      /Capacitor\.isNativePlatform\(\)\s*&&\s*\(\s*<SettingsCollapsible[\s\S]*settings-order-alerts-toggle/,
    );
    expect(src).toContain("<VendorSettingsOrderAlertsContent");
  });
});
