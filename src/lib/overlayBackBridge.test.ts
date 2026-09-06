import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  pushOverlayBackHandler,
  setOverlayBackHandler,
  tryHandleOverlayBack,
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
