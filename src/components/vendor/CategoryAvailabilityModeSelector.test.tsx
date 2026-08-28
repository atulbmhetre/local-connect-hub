import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      reg_avail_three_way_question: "How do you take requests for this business?",
      reg_avail_choice_urgent: "Urgent / same-day only",
      reg_avail_choice_scheduled: "Scheduled / booked only",
      reg_avail_choice_both: "Both — urgent and scheduled",
      reg_avail_deliver_question: "Deliver?",
      reg_avail_deliver_yes: "Yes",
      reg_avail_pickup_only: "Pickup",
    },
  }),
}));

describe("CategoryAvailabilityModeSelector three-way", () => {
  it("starts with nothing selected and emits modes for each choice", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CategoryAvailabilityModeSelector
        value={[]}
        onChange={onChange}
        catalogServiceMode="help"
        testIdPrefix="reg-avail"
      />,
    );

    expect(screen.getByTestId("reg-avail-choice-urgent")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("reg-avail-choice-scheduled")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("reg-avail-choice-both")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByTestId("reg-avail-choice-urgent"));
    expect(onChange).toHaveBeenLastCalledWith(["help"]);

    rerender(
      <CategoryAvailabilityModeSelector
        value={["appointment"]}
        onChange={onChange}
        catalogServiceMode="appointment"
        testIdPrefix="reg-avail"
      />,
    );
    expect(screen.getByTestId("reg-avail-choice-scheduled")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByTestId("reg-avail-choice-both"));
    expect(onChange).toHaveBeenLastCalledWith(["help", "appointment"]);
  });
});
