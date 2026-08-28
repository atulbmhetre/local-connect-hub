import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryPicker } from "@/components/CategoryPicker";
import type { Category } from "@/lib/supabase";

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      category_picker_quick_help: "Quick help",
      category_picker_title: "What do you need?",
      category_picker_speak_else: "Something else — speak it",
      category_mode_help: "Help",
      category_mode_delivery: "Delivery",
      category_mode_appointment: "Appointment",
    },
  }),
}));

vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  return {
    ...actual,
    useCategoryLabel: () => (label: string) => label,
  };
});

const cats: Category[] = [
  {
    id: "1",
    label: "Plumber",
    emoji: "🚰",
    service_mode: "help",
    is_active: true,
    sort_order: 1,
  },
  {
    id: "2",
    label: "Grocery Store",
    emoji: "🛒",
    service_mode: "delivery",
    is_active: true,
    sort_order: 2,
  },
  {
    id: "3",
    label: "Painter",
    emoji: "🎨",
    service_mode: "appointment",
    is_active: true,
    sort_order: 3,
  },
];

describe("CategoryPicker Phase 8", () => {
  it("groups categories by service_mode and keeps Painter under Appointment", () => {
    render(
      <CategoryPicker
        open
        onClose={() => {}}
        onPick={() => {}}
        onMic={() => {}}
        categories={cats}
      />,
    );

    expect(screen.getByTestId("category-picker-mode-help")).toBeTruthy();
    expect(screen.getByTestId("category-picker-mode-delivery")).toBeTruthy();
    expect(screen.getByTestId("category-picker-mode-appointment")).toBeTruthy();

    const painterBtn = screen
      .getAllByTestId("category-picker-option")
      .find((el) => el.getAttribute("data-category-label") === "Painter");
    expect(painterBtn?.getAttribute("data-service-mode")).toBe("appointment");
    expect(
      screen.getByTestId("category-picker-mode-appointment").contains(painterBtn!),
    ).toBe(true);

    // No text search input — tap-only (+ mic)
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
