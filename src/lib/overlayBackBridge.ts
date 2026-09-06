/**
 * Stacked native/hardware back claims for in-page overlays that are not routes.
 * NativeBackButtonHandler calls tryHandleOverlayBack() before history.back().
 * Use useOverlayBack (or pushOverlayBackHandler) so nested sheets hand back
 * to the parent overlay instead of a single global slot.
 */
import { useCallback, useEffect, useRef } from "react";

export type OverlayBackHandler = () => boolean;

const stack: OverlayBackHandler[] = [];

/** Push a handler; returns unregister. Top of stack receives hardware back first. */
export function pushOverlayBackHandler(handler: OverlayBackHandler): () => void {
  stack.push(handler);
  return () => {
    const idx = stack.lastIndexOf(handler);
    if (idx >= 0) stack.splice(idx, 1);
  };
}

export function tryHandleOverlayBack(): boolean {
  const top = stack[stack.length - 1];
  return top?.() ?? false;
}

/**
 * @deprecated Prefer pushOverlayBackHandler / useOverlayBack.
 * Replaces the entire stack with one handler (or clears it) — legacy AdminConsole API.
 */
export function setOverlayBackHandler(next: OverlayBackHandler | null): void {
  stack.length = 0;
  if (next) stack.push(next);
}

/**
 * When `open` becomes true: pushState + register hardware back to close.
 * Call the returned `requestClose` from UI close actions so history stays in sync.
 */
export function useOverlayBack(
  open: boolean,
  closeUi: () => void,
  historyKey: string,
): () => void {
  const historyPushedRef = useRef(false);
  const closingFromPopRef = useRef(false);
  const closeUiRef = useRef(closeUi);
  closeUiRef.current = closeUi;

  const requestClose = useCallback(() => {
    const shouldPop = historyPushedRef.current;
    historyPushedRef.current = false;
    closeUiRef.current();
    if (
      shouldPop &&
      !closingFromPopRef.current &&
      (window.history.state as Record<string, unknown> | null)?.[historyKey]
    ) {
      window.history.back();
    }
  }, [historyKey]);

  useEffect(() => {
    if (!open) {
      if (
        historyPushedRef.current &&
        !closingFromPopRef.current &&
        (window.history.state as Record<string, unknown> | null)?.[historyKey]
      ) {
        historyPushedRef.current = false;
        window.history.back();
      } else {
        historyPushedRef.current = false;
      }
      return;
    }

    const onPopState = () => {
      closingFromPopRef.current = true;
      historyPushedRef.current = false;
      closeUiRef.current();
      closingFromPopRef.current = false;
    };
    window.addEventListener("popstate", onPopState);

    if (!historyPushedRef.current) {
      window.history.pushState({ [historyKey]: true }, "");
      historyPushedRef.current = true;
    }

    const unregister = pushOverlayBackHandler(() => {
      if (historyPushedRef.current) {
        window.history.back();
        return true;
      }
      closeUiRef.current();
      return true;
    });

    return () => {
      unregister();
      window.removeEventListener("popstate", onPopState);
    };
  }, [open, historyKey]);

  return requestClose;
}
