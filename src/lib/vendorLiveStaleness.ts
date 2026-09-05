/**
 * Live-vendor GPS freshness.
 *
 * VendorMode pings `last_updated` every 20 minutes while the process is alive.
 * Capgo/help heartbeats also refresh it. Once the app is killed, those pings stop
 * and `is_active` alone would leave a vendor discoverable with stale coords.
 *
 * Threshold is 45 minutes (~2× the 20-min ping) so one delayed ping does not
 * flap offline; matches `app_config.vendor_live_stale_minutes` / cron.
 */

/** Keep in sync with migration `vendor_live_stale_minutes` default (45). */
export const VENDOR_LIVE_STALE_MS = 45 * 60 * 1000;

export function isVendorLiveLocationFresh(
  lastUpdated: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastUpdated) return false;
  const ts = Date.parse(lastUpdated);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= VENDOR_LIVE_STALE_MS;
}

/** True when the vendor should appear "live" to customers (active + fresh GPS). */
export function isVendorEffectivelyLive(
  vendor: {
    is_active?: boolean | null;
    last_updated?: string | null;
  },
  nowMs: number = Date.now(),
): boolean {
  if (vendor.is_active !== true) return false;
  return isVendorLiveLocationFresh(vendor.last_updated, nowMs);
}

/** ISO lower bound for PostgREST `.gte("last_updated", …)` live filters. */
export function liveLocationFreshSinceIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - VENDOR_LIVE_STALE_MS).toISOString();
}
