import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Settings legal links", () => {
  const settingsSrc = readFileSync(resolve(__dirname, "Settings.tsx"), "utf8");
  const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");

  it("links Privacy Policy and Terms of Service from Connection & Privacy", () => {
    const privacy = settingsSrc.indexOf('data-testid="settings-privacy-policy-link"');
    const terms = settingsSrc.indexOf('data-testid="settings-terms-of-service-link"');
    const help = settingsSrc.indexOf('data-testid="settings-help-support-link"');

    expect(privacy).toBeGreaterThan(-1);
    expect(terms).toBeGreaterThan(privacy);
    expect(help).toBeGreaterThan(terms);
    expect(settingsSrc).toContain('navigate("/privacy"');
    expect(settingsSrc).toContain('navigate("/terms"');
  });

  it("registers /terms route with TermsOfService page", () => {
    expect(appSrc).toContain('path="/terms"');
    expect(appSrc).toContain("TermsOfService");
  });
});

describe("public delete-account page", () => {
  const html = readFileSync(resolve("public/delete-account.html"), "utf8");

  it("exists and documents in-app and email deletion without login", () => {
    expect(html).toContain("Delete Your Account");
    expect(html).toContain("Settings");
    expect(html).toContain("Delete Account");
    expect(html).toContain("support@aaspaaspro.com");
    expect(html).toContain("registered");
    expect(html).toMatch(/do <strong>not<\/strong> need to install the app/i);
  });
});
