/**
 * Lets FirstOpen claim the Android hardware back button while the overlay is open.
 * NativeBackButtonHandler calls tryHandleFirstOpenBack() first; if it returns true,
 * the event was consumed (step pop). Otherwise fall through to exitApp / history.back.
 */
type BackHandler = () => boolean;

let handler: BackHandler | null = null;

export function setFirstOpenBackHandler(next: BackHandler | null): void {
  handler = next;
}

export function tryHandleFirstOpenBack(): boolean {
  return handler?.() ?? false;
}
