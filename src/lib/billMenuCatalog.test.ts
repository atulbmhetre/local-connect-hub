import { describe, expect, it } from "vitest";
import {
  applyCatalogItemTap,
  lineFromCatalogItem,
  type BillCatalogLine,
  type BillCatalogMenuItem,
} from "@/lib/billMenuCatalog";

const tea: BillCatalogMenuItem = {
  id: "menu-tea",
  name: "Chai",
  price: 20,
  unit: "pc",
  category_id: "cat-1",
};

const blank = (): BillCatalogLine => ({
  id: "blank-1",
  description: "",
  quantity: "1",
  unit: "",
  unit_price: "",
});

describe("billMenuCatalog", () => {
  it("lineFromCatalogItem maps name/price/unit and qty 1", () => {
    expect(lineFromCatalogItem(tea)).toMatchObject({
      description: "Chai",
      quantity: "1",
      unit: "pc",
      unit_price: "20",
      menu_item_id: "menu-tea",
    });
  });

  it("first tap replaces blank placeholder", () => {
    const next = applyCatalogItemTap([blank()], tea, blank);
    expect(next).toHaveLength(1);
    expect(next[0].menu_item_id).toBe("menu-tea");
    expect(next[0].description).toBe("Chai");
    expect(next[0].quantity).toBe("1");
  });

  it("re-tap increments quantity instead of duplicating", () => {
    const once = applyCatalogItemTap([blank()], tea, blank);
    const twice = applyCatalogItemTap(once, tea, blank);
    expect(twice).toHaveLength(1);
    expect(twice[0].quantity).toBe("2");
    const thrice = applyCatalogItemTap(twice, tea, blank);
    expect(thrice).toHaveLength(1);
    expect(thrice[0].quantity).toBe("3");
  });

  it("different menu items add separate lines", () => {
    const coffee: BillCatalogMenuItem = {
      id: "menu-coffee",
      name: "Coffee",
      price: 40,
      unit: "pc",
      category_id: null,
    };
    const withTea = applyCatalogItemTap([blank()], tea, blank);
    const withBoth = applyCatalogItemTap(withTea, coffee, blank);
    expect(withBoth).toHaveLength(2);
    expect(withBoth.map((l) => l.menu_item_id).sort()).toEqual([
      "menu-coffee",
      "menu-tea",
    ]);
  });
});
