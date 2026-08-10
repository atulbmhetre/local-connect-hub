/**
 * Shared native/hardware back claim for in-page overlays that are not routes.
 * NativeBackButtonHandler calls tryHandleOverlayBack() before history.back().
 * Also used with history.pushState + popstate so browser back closes the overlay.
 */
type BackHandler = () => boolean;

let handler: BackHandler | null = null;

export function setOverlayBackHandler(next: BackHandler | null): void {
  handler = next;
}

export function tryHandleOverlayBack(): boolean {
  return handler?.() ?? false;
}
