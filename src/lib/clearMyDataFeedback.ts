/** Delay so the success toast is visible before hard reload. */
export const CLEAR_MY_DATA_RELOAD_DELAY_MS = 1800;

/**
 * Show clear-data success feedback, then reload after a short delay.
 * Extracted so tests can assert the toast stays mounted before reload fires.
 */
export function showClearMyDataSuccessThenReload(opts: {
  message: string;
  toastSuccess: (message: string) => void;
  reload?: () => void;
  delayMs?: number;
}): void {
  const reload = opts.reload ?? (() => window.location.reload());
  const delayMs = opts.delayMs ?? CLEAR_MY_DATA_RELOAD_DELAY_MS;
  opts.toastSuccess(opts.message);
  window.setTimeout(() => {
    reload();
  }, delayMs);
}
