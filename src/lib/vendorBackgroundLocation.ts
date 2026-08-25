import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { BackgroundGeolocation } from "@capgo/background-geolocation";
import { patchVendorOwn } from "@/lib/vendorPatch";
import { supabase } from "@/lib/supabase";
import { strings, type Language } from "@/lib/strings";
import { ensureHelpTrackingPermissions } from "@/lib/nativePermissions";
import {
  VENDOR_LOCATION_DISTANCE_FILTER_M,
  shouldRestoreOrderTracking,
  vendorOffersHelp,
  type OrderTrackingSlice,
} from "@/lib/vendorTrackingPolicy";

const HELP_SOURCE = "help-live";
const orderSource = (orderId: string) => `order:${orderId}`;

/** Time-based GPS heartbeat while Help Go-Live is on (tab must be visible on web). */
export const VENDOR_STOPPED_HEARTBEAT_MS = 3 * 60 * 1000;

type VendorCtx = {
  vendorId: string;
  vendorPhone: string;
};

const sources = new Set<string>();
const helpAcceptedOrderIds = new Set<string>();
let watcherRunning = false;
let startInFlight: Promise<void> | null = null;
let activeCtx: VendorCtx | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function readLang(): Language {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    return stored === "hi" || stored === "mr" ? stored : "en";
  } catch {
    return "en";
  }
}

function trackingNotificationCopy(): { title: string; message: string } {
  const s = strings[readLang()];
  return {
    title: s.vendor_tracking_notification_title,
    message: s.vendor_tracking_notification_body,
  };
}

async function writeLocation(lat: number, lng: number): Promise<void> {
  const ctx = activeCtx;
  if (!ctx) return;
  const { error } = await patchVendorOwn(ctx.vendorId, ctx.vendorPhone, {
    latitude: lat,
    longitude: lng,
    last_updated: new Date().toISOString(),
  });
  if (error) {
    console.error("vendorBackgroundLocation patch failed:", error.message);
  }
}

async function writePeriodicLocation(): Promise<void> {
  if (!activeCtx) return;
  try {
    const pos = await Geolocation.getCurrentPosition({ timeout: 15_000 });
    await writeLocation(pos.coords.latitude, pos.coords.longitude);
  } catch (err) {
    console.error("vendorBackgroundLocation periodic ping failed:", err);
  }
}

function pageIsVisible(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

let visibilityListenerAttached = false;

function ensureVisibilityListener(): void {
  if (visibilityListenerAttached || typeof document === "undefined") return;
  visibilityListenerAttached = true;
  document.addEventListener("visibilitychange", () => {
    reconcileHelpLiveHeartbeat();
  });
}

function reconcileHelpLiveHeartbeat(): void {
  const shouldRun = sources.has(HELP_SOURCE) && pageIsVisible();
  if (shouldRun && !heartbeatTimer) {
    void writePeriodicLocation();
    heartbeatTimer = setInterval(() => {
      void writePeriodicLocation();
    }, VENDOR_STOPPED_HEARTBEAT_MS);
  } else if (!shouldRun && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function ensureWatcherStarted(
  ctx: VendorCtx,
  requestMissingPermissions = false,
): Promise<void> {
  activeCtx = ctx;
  if (!Capacitor.isNativePlatform()) {
    // Web/Playwright: sources still tracked; no FGS. Go-live uses one-shot GPS separately.
    return;
  }
  if (watcherRunning) return;
  if (startInFlight) {
    await startInFlight;
    return;
  }

  const { title, message } = trackingNotificationCopy();
  startInFlight = (async () => {
    try {
      if (requestMissingPermissions) {
        await ensureHelpTrackingPermissions();
      }
      await BackgroundGeolocation.start(
        {
          backgroundTitle: title,
          backgroundMessage: message,
          requestPermissions: false,
          stale: false,
          distanceFilter: VENDOR_LOCATION_DISTANCE_FILTER_M,
        },
        (location, error) => {
          if (error) {
            console.error("vendorBackgroundLocation:", error.message);
            return;
          }
          if (!location || sources.size === 0) return;
          void writeLocation(location.latitude, location.longitude);
        },
      );
      watcherRunning = true;
    } catch (err) {
      console.error("vendorBackgroundLocation start failed:", err);
      watcherRunning = false;
    } finally {
      startInFlight = null;
    }
  })();

  await startInFlight;
}

async function ensureWatcherStopped(): Promise<void> {
  if (sources.size > 0) return;
  activeCtx = null;
  if (!Capacitor.isNativePlatform()) {
    watcherRunning = false;
    return;
  }
  if (!watcherRunning) return;
  try {
    await BackgroundGeolocation.stop();
  } catch (err) {
    console.error("vendorBackgroundLocation stop failed:", err);
  } finally {
    watcherRunning = false;
  }
}

async function addSource(
  key: string,
  ctx: VendorCtx,
  requestMissingPermissions = false,
): Promise<void> {
  sources.add(key);
  ensureVisibilityListener();
  await ensureWatcherStarted(ctx, requestMissingPermissions);
  reconcileHelpLiveHeartbeat();
}

async function removeSource(key: string): Promise<void> {
  sources.delete(key);
  reconcileHelpLiveHeartbeat();
  await ensureWatcherStopped();
}

/** Case 1 — Help Go-Live continuous tracking. */
export async function startHelpLiveTracking(
  ctx: VendorCtx,
  options?: { requestMissingPermissions?: boolean },
): Promise<void> {
  await addSource(HELP_SOURCE, ctx, options?.requestMissingPermissions === true);
}

export async function stopHelpLiveTracking(): Promise<void> {
  await removeSource(HELP_SOURCE);
}

/** Cases 2 & 3 — order-scoped instant Booking/Delivery tracking. */
export async function startOrderTracking(
  orderId: string,
  ctx: VendorCtx,
): Promise<void> {
  if (!orderId) return;
  await addSource(orderSource(orderId), ctx);
}

export async function stopOrderTracking(orderId: string): Promise<void> {
  if (!orderId) return;
  await removeSource(orderSource(orderId));
}

/** Logout / wipe — stop everything. */
export async function stopAllVendorLocationTracking(): Promise<void> {
  sources.clear();
  helpAcceptedOrderIds.clear();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await ensureWatcherStopped();
}

/**
 * Keep Help accepted-order ids for restore/sync.
 * Heartbeat runs when Go-Live (help-live source) is active and the tab is visible.
 */
export function syncHelpAcceptedOrderTracking(
  orderIds: readonly string[],
  ctx: VendorCtx,
): void {
  activeCtx = ctx;
  helpAcceptedOrderIds.clear();
  for (const id of orderIds) {
    const trimmed = id?.trim();
    if (trimmed) helpAcceptedOrderIds.add(trimmed);
  }
  reconcileHelpLiveHeartbeat();
}

/** Test/introspection helpers (not for UI). */
export function getActiveTrackingSourcesForTests(): string[] {
  return [...sources].sort();
}

export function isVendorLocationWatcherRunningForTests(): boolean {
  return watcherRunning || (!Capacitor.isNativePlatform() && sources.size > 0);
}

export function isHelpStoppedHeartbeatRunningForTests(): boolean {
  return heartbeatTimer != null;
}

export function getHelpAcceptedOrderIdsForTests(): string[] {
  return [...helpAcceptedOrderIds].sort();
}

/**
 * Cold-start restore: Help still live, and/or in-progress instant orders (cases 2/3).
 * FGS may have been killed by the OS while sources are still valid.
 */
export async function restoreVendorLocationTracking(): Promise<void> {
  let vendorId: string | null = null;
  let phone: string | null = null;
  try {
    vendorId = localStorage.getItem("aaspaas:vendor_id");
    phone = localStorage.getItem("aaspaas:user_phone");
  } catch {
    return;
  }
  if (!vendorId || !phone) return;

  // get_vendor_own works for hidden/offline/draft vendors too (public
  // discoverability RLS would hide them from a direct vendors read).
  const { data: vendor, error: vendorError } = await supabase.rpc("get_vendor_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone.trim(),
  });
  if (vendorError || !vendor?.phone) return;

  const { data: modeRows } = await supabase
    .from("vendor_availability_modes")
    .select("mode")
    .eq("vendor_id", vendorId);
  const availability_modes = (modeRows ?? []).map((r) => String(r.mode));

  const ctx: VendorCtx = { vendorId: vendor.id, vendorPhone: vendor.phone };

  if (
    vendor.is_active &&
    vendorOffersHelp({
      service_mode: vendor.service_mode,
      availability_modes,
    })
  ) {
    await startHelpLiveTracking(ctx);
  } else {
    await stopHelpLiveTracking();
  }

  const { data: orders } = await supabase.rpc("get_vendor_accepted_orders", {
    p_vendor_id: vendorId,
    p_vendor_phone: vendor.phone,
  });

  const activeOrderIds = new Set<string>();
  for (const row of (orders ?? []) as OrderTrackingSlice[]) {
    if (shouldRestoreOrderTracking(row)) {
      activeOrderIds.add(row.id);
      await startOrderTracking(row.id, ctx);
    }
  }

  // Drop stale order sources that are no longer accepted/instant.
  for (const key of [...sources]) {
    if (!key.startsWith("order:")) continue;
    const id = key.slice("order:".length);
    if (!activeOrderIds.has(id)) {
      await stopOrderTracking(id);
    }
  }
}
