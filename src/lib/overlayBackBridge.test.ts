import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  pushOverlayBackHandler,
  setOverlayBackHandler,
  tryHandleOverlayBack,
  useOverlayBack,
} from "./overlayBackBridge";

describe("overlayBackBridge stack", () => {
  beforeEach(() => {
    setOverlayBackHandler(null);
  });

  it("invokes the top handler only", () => {
    const outer = vi.fn(() => true);
    const inner = vi.fn(() => true);
    pushOverlayBackHandler(outer);
    const unInner = pushOverlayBackHandler(inner);

    expect(tryHandleOverlayBack()).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    unInner();
    expect(tryHandleOverlayBack()).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("returns false when stack empty", () => {
    expect(tryHandleOverlayBack()).toBe(false);
  });

  it("setOverlayBackHandler replaces the stack", () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    pushOverlayBackHandler(a);
    setOverlayBackHandler(b);
    tryHandleOverlayBack();
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});

describe("useOverlayBack skipHistoryPop", () => {
  beforeEach(() => {
    setOverlayBackHandler(null);
    window.history.replaceState({}, "", "/");
  });

  it("does not history.back when skipHistoryPop is set, including after open becomes false", () => {
    const closeUi = vi.fn();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useOverlayBack(open, closeUi, "testOverlay"),
      { initialProps: { open: false } },
    );

    act(() => {
      rerender({ open: true });
    });
    expect((window.history.state as { testOverlay?: boolean } | null)?.testOverlay).toBe(true);

    act(() => {
      result.current({ skipHistoryPop: true });
    });
    expect(closeUi).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();

    act(() => {
      rerender({ open: false });
    });
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("history.back when closing without skipHistoryPop", () => {
    const closeUi = vi.fn();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useOverlayBack(open, closeUi, "testOverlay"),
      { initialProps: { open: false } },
    );

    act(() => {
      rerender({ open: true });
    });

    act(() => {
      result.current();
    });
    expect(closeUi).toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});
