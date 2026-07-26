import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CLEAR_MY_DATA_RELOAD_DELAY_MS,
  showClearMyDataSuccessThenReload,
} from "@/lib/clearMyDataFeedback";

describe("showClearMyDataSuccessThenReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the success toast mounted in the DOM until reload fires (~1.8s later)", () => {
    const reload = vi.fn();
    const toastSuccess = (message: string) => {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "clear-my-data-success-toast");
      el.textContent = message;
      document.body.appendChild(el);
    };

    showClearMyDataSuccessThenReload({
      message: "Local data cleared",
      toastSuccess,
      reload,
    });

    expect(screen.getByTestId("clear-my-data-success-toast")).toBeInTheDocument();
    expect(screen.getByTestId("clear-my-data-success-toast")).toHaveTextContent(
      "Local data cleared",
    );
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CLEAR_MY_DATA_RELOAD_DELAY_MS - 1);
    expect(screen.getByTestId("clear-my-data-success-toast")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
