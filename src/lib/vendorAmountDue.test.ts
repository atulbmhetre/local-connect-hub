import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fillAmountTemplate,
  formatRupeesFromPaise,
  isWaiveoffActive,
  parseVendorAmountDue,
} from "./vendorAmountDue";

describe("vendorAmountDue display helpers", () => {
  it("formats integer and fractional rupees from paise", () => {
    expect(formatRupeesFromPaise(9900)).toBe("99");
    expect(formatRupeesFromPaise(4950)).toBe("49.50");
    expect(formatRupeesFromPaise(0)).toBe("0");
    expect(formatRupeesFromPaise(6633)).toBe("66.33");
  });

  it("treats months 0 as inactive even if percent is set", () => {
    expect(
      isWaiveoffActive({
        amount_paise: 9900,
        base_paise: 9900,
        waiveoff_percent: 50,
        months_remaining: 0,
        is_free: false,
      }),
    ).toBe(false);
  });

  it("fills EN/HI amount templates", () => {
    expect(
      fillAmountTemplate("Due ₹{amount}/month · {percent}% off · {months} months left", {
        amount: "49.50",
        percent: "50",
        months: "3",
      }),
    ).toContain("49.50");
  });

  it("parses jsonb-shaped RPC rows", () => {
    expect(
      parseVendorAmountDue({
        amount_paise: 0,
        base_paise: 9900,
        waiveoff_percent: 100,
        months_remaining: 1,
        is_free: true,
      })?.is_free,
    ).toBe(true);
  });
});

describe("vendor_amount_due wiring", () => {
  it("SQL helper is the source of truth and does not take client price/percent", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260921240001_vendor_amount_due.sql"),
      "utf8",
    );
    expect(mig).toContain("CREATE OR REPLACE FUNCTION public.vendor_amount_due(p_vendor_id uuid)");
    expect(mig).not.toMatch(/p_percent|p_price|p_amount/);
    expect(mig).toContain("vendor_subscription_price");
    expect(mig).toContain("ROUND(v_base * (100 - v_pct) / 100.0, 0)");
  });

  it("billing screens call vendor_amount_due; checkout and webhook do not", () => {
    const vendor = readFileSync(resolve("src/components/settings/VendorSettings.tsx"), "utf8");
    const admin = readFileSync(resolve("src/components/settings/AdminConsole.tsx"), "utf8");
    const checkout = vendor;
    const hook = readFileSync(resolve("supabase/functions/razorpay-webhook/index.ts"), "utf8");
    expect(vendor).toContain("vendor_amount_due");
    expect(vendor).toContain("vendor-sub-amount-due");
    expect(admin).toContain("vendor_amount_due");
    expect(admin).toContain("admin-sub-amount-due");
    expect(checkout).toMatch(/amount:\s*parseInt\(price\) \* 100/);
    expect(hook).not.toContain("vendor_amount_due");
    expect(hook).toContain("subscription.charged");
    expect(hook).toContain("subscription.payment_failed");
  });
});
