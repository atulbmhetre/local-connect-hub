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
    document.body.replaceChildren();
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

  it("shows the permission nudge in the same toast when OS notifications are still granted", () => {
    const reload = vi.fn();
    const toastSuccess = (message: string, description?: string) => {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "clear-my-data-success-toast");
      el.textContent = description ? `${message} ${description}` : message;
      document.body.appendChild(el);
    };

    showClearMyDataSuccessThenReload({
      message: "Account data cleared from this device and our servers",
      description:
        "OS-level permissions (camera, notifications, location) aren't touched. Change those yourself in your phone's Settings.",
      toastSuccess,
      reload,
    });

    expect(screen.getByTestId("clear-my-data-success-toast")).toHaveTextContent(
      /notifications remain|aren't touched/i,
    );
  });
});
