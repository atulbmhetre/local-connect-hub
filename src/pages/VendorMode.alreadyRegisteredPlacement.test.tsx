import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { strings } from "@/lib/strings";

/**
 * Document-order harness matching VendorMode registration entry layout:
 * Find-my-account link first, then registration wizard form.
 */
function VendorRegistrationEntryLayout() {
  const s = strings.en;
  return (
    <div>
      <button type="button" data-testid="vendor-already-registered-link">
        {s.vendor_already_registered}
      </button>
      <form data-testid="vendor-registration-wizard">
        <label htmlFor="reg-phone">{s.vendor_phone_label}</label>
        <input id="reg-phone" />
      </form>
    </div>
  );
}

describe("Vendor already-registered link placement", () => {
  it("renders Find my account above the registration form fields", () => {
    render(<VendorRegistrationEntryLayout />);

    const link = screen.getByTestId("vendor-already-registered-link");
    const wizard = screen.getByTestId("vendor-registration-wizard");
    expect(link).toHaveTextContent(strings.en.vendor_already_registered);
    // FOLLOWING means wizard comes after link in document order.
    expect(link.compareDocumentPosition(wizard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("VendorMode.tsx places the already-registered link before VendorRegistrationWizard", () => {
    const src = readFileSync(resolve(__dirname, "VendorMode.tsx"), "utf8");
    const linkIdx = src.indexOf('data-testid="vendor-already-registered-link"');
    const wizardIdx = src.indexOf("<VendorRegistrationWizard");
    expect(linkIdx).toBeGreaterThan(-1);
    expect(wizardIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeLessThan(wizardIdx);
  });

  it("does not reconcile vendor_active while the vendor row is still null", () => {
    const src = readFileSync(resolve(__dirname, "VendorMode.tsx"), "utf8");
    expect(src).toMatch(/if \(!vendor\) return;\s*reconcileVendorActiveFlag/);
  });
});
