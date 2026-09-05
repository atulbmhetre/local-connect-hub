import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("min delivery order wiring", () => {
  it("migration adds vendor_categories column and enforces p_items in create_customer_request", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260831140001_min_delivery_order_amount.sql"),
      "utf8",
    );
    expect(mig).toContain("min_delivery_order_amount");
    expect(mig).toContain("vendor_categories_min_delivery_order_amount_pos");
    expect(mig).toContain("_delivery_items_subtotal");
    expect(mig).toContain("below_min_delivery_order");
    expect(mig).toContain("vendor_update_category_profile");
    expect(mig).toContain("create_customer_request");
  });

  it("Parchi keeps the cart through Add to order and recomputes items at submit", () => {
    const parchi = readFileSync(resolve("src/components/ParchiSheet.tsx"), "utf8");
    expect(parchi).toContain("selectedMenuItemsRef");
    expect(parchi).toContain("menuItemsRef");
    expect(parchi).toContain("parchi-min-delivery-subtotal");
    expect(parchi).toContain("parchi-min-delivery-need");
    expect(parchi).toContain("executeOrderInsert");
    const addFn = parchi.slice(
      parchi.indexOf("const addMenuToOrder"),
      parchi.indexOf("const selectedMenuCount"),
    );
    expect(addFn).not.toMatch(/setSelectedMenuItems\(\{\}\)/);
    expect(parchi).toMatch(/selectedMenuItems,\s*\n\s*menuItems,/);

    const place = readFileSync(resolve("src/lib/executeOrderInsert.ts"), "utf8");
    expect(place).toContain("buildStructuredItemsFrom");
    expect(place).toContain("meetsMinDeliveryOrder");
  });

  it("My Business shows the field only for delivery modes", () => {
    const src = readFileSync(resolve("src/components/settings/VendorMyBusiness.tsx"), "utf8");
    expect(src).toContain("min_delivery_order_amount");
    expect(src).toContain("vendor_min_delivery_label");
    expect(src).toContain("my-business-min-delivery-");
    expect(src).toContain("vendor_min_delivery_no_menu_warning");
  });
});
