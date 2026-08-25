import type { PermissionState } from "@capacitor/core";
import { Camera as CapacitorCamera } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";
import { PushNotifications } from "@capacitor/push-notifications";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { BackgroundGeolocation } from "@capgo/background-geolocation";

export type NativePermissionKind =
  | "notifications"
  | "location"
  | "backgroundLocation"
  | "camera"
  | "microphone";

export type NativePermissionStatuses = {
  notifications: PermissionState;
  location: PermissionState;
  backgroundLocation: PermissionState;
  camera: PermissionState | "limited";
  microphone: PermissionState;
};

export const DEFAULT_NATIVE_PERMISSION_STATUSES: NativePermissionStatuses = {
  notifications: "prompt",
  location: "prompt",
  backgroundLocation: "prompt",
  camera: "prompt",
  microphone: "prompt",
};

/** FirstOpen "Not now" — timestamp; presence means skip passive notification prompts. */
export const NOTIF_SKIP_AT_KEY = "aaspaas:notif_skip_at";

export type PermissionEnsureTrigger = "explicit" | "passive";

type CapgoPermissionPlugin = {
  checkPermissions?: () => Promise<{
    location?: PermissionState;
    backgroundLocation?: PermissionState | "when_in_use" | "always";
    notification?: PermissionState;
  }>;
  requestPermissions?: (options?: {
    permissions?: Array<"location" | "backgroundLocation" | "notification">;
  }) => Promise<{
    location?: PermissionState;
    backgroundLocation?: PermissionState | "when_in_use" | "always";
    notification?: PermissionState;
  }>;
};

const capgo = BackgroundGeolocation as unknown as CapgoPermissionPlugin;

export function markNotificationSkip(): void {
  try {
    localStorage.setItem(NOTIF_SKIP_AT_KEY, String(Date.now()));
  } catch {
    /* ignore quota / private mode */
  }
}

export function hasNotificationSkip(): boolean {
  try {
    const raw = localStorage.getItem(NOTIF_SKIP_AT_KEY);
    if (raw == null || raw === "") return false;
    return Number.isFinite(Number(raw));
  } catch {
    return false;
  }
}

export function clearNotificationSkip(): void {
  try {
    localStorage.removeItem(NOTIF_SKIP_AT_KEY);
  } catch {
    /* ignore */
  }
}

function normalizeBackgroundLocation(
  status: PermissionState | "when_in_use" | "always" | undefined,
): PermissionState {
  if (status === "granted" || status === "always") return "granted";
  if (status === "denied") return "denied";
  // when_in_use / prompt / missing: not Always / all-the-time yet
  return "prompt";
}

function fallbackPrompt<T extends Record<string, PermissionState>>(value: T): T {
  return value;
}

/**
 * Live OS permission snapshot — never cache in localStorage / Preferences.
 * Same idea as Battery Optimization (Manual): the OS is source of truth.
 */
export async function checkNativePermissionStatuses(): Promise<NativePermissionStatuses> {
  const [push, geo, cam, mic, bg] = await Promise.all([
    PushNotifications.checkPermissions().catch(() => ({ receive: "prompt" as PermissionState })),
    Geolocation.checkPermissions().catch(() =>
      fallbackPrompt({ location: "prompt" as PermissionState }),
    ),
    CapacitorCamera.checkPermissions().catch(() => ({
      camera: "prompt" as PermissionState,
    })),
    SpeechRecognition.checkPermissions().catch(() => ({
      speechRecognition: "prompt" as PermissionState,
    })),
    typeof capgo.checkPermissions === "function"
      ? capgo.checkPermissions().catch(() => ({
          backgroundLocation: "prompt" as PermissionState,
        }))
      : Promise.resolve({ backgroundLocation: "prompt" as PermissionState }),
  ]);
  return {
    notifications: push.receive,
    location: geo.location,
    backgroundLocation: normalizeBackgroundLocation(bg.backgroundLocation),
    camera: cam.camera,
    microphone: mic.speechRecognition,
  };
}

export function isPermissionGranted(status: PermissionState | "limited"): boolean {
  return status === "granted" || status === "limited";
}

/**
 * Request a single permission from the OS.
 * Camera requests camera only (not photos) so a photos grant/dismiss cannot
 * falsely tick Camera "Allow".
 */
export async function requestNativePermission(
  kind: NativePermissionKind,
): Promise<PermissionState | "limited"> {
  switch (kind) {
    case "notifications": {
      const result = await PushNotifications.requestPermissions();
      if (result.receive === "granted") {
        void PushNotifications.register();
        clearNotificationSkip();
      }
      return result.receive;
    }
    case "location": {
      const result = await Geolocation.requestPermissions();
      return result.location;
    }
    case "backgroundLocation": {
      const live = await checkNativePermissionStatuses();
      if (!isPermissionGranted(live.location)) {
        const fg = await Geolocation.requestPermissions();
        if (!isPermissionGranted(fg.location)) return fg.location;
      }
      if (typeof capgo.requestPermissions === "function") {
        const result = await capgo.requestPermissions({
          permissions: ["backgroundLocation"],
        });
        return normalizeBackgroundLocation(result.backgroundLocation);
      }
      // Plugin without a dedicated request API: foreground grant is the best we can do.
      const after = await checkNativePermissionStatuses();
      return after.backgroundLocation;
    }
    case "camera": {
      const result = await CapacitorCamera.requestPermissions({
        permissions: ["camera"],
      });
      return result.camera;
    }
    case "microphone": {
      const result = await SpeechRecognition.requestPermissions();
      return result.speechRecognition;
    }
  }
}

/**
 * Live-check first. Never prompt if already granted.
 * Permanently denied: do not show the OS dialog again.
 * prompt + passive: prompt only when the kind is notifications and the user
 * has not tapped FirstOpen "Not now". Other kinds never prompt from passive
 * triggers (page-load token registration, silent GPS, restore tracking).
 * prompt + explicit: always request (Settings Allow, FirstOpen Allow, go-live).
 */
export async function ensureNativePermission(
  kind: NativePermissionKind,
  trigger: PermissionEnsureTrigger,
): Promise<PermissionState | "limited"> {
  let live: NativePermissionStatuses = DEFAULT_NATIVE_PERMISSION_STATUSES;
  try {
    live = await checkNativePermissionStatuses();
  } catch {
    /* treat as defaults (prompt) */
  }
  const current = live[kind];
  if (isPermissionGranted(current)) return current;
  if (current === "denied") return current;

  if (trigger === "passive") {
    if (kind === "notifications" && hasNotificationSkip()) {
      return current;
    }
    if (kind !== "notifications") {
      return current;
    }
  }

  return requestNativePermission(kind);
}

export async function ensureNativePermissionGranted(
  kind: NativePermissionKind,
  trigger: PermissionEnsureTrigger,
): Promise<boolean> {
  const status = await ensureNativePermission(kind, trigger);
  return isPermissionGranted(status);
}

/** Mic tap — explicit user action. */
export async function ensureVoiceMicrophone(): Promise<boolean> {
  return ensureNativePermissionGranted("microphone", "explicit");
}

/**
 * Help go-live / live tracking. Prompts only for kinds that are still `prompt`.
 * Location is explicit (user tapped Online). Notifications use the passive
 * gate so FirstOpen "Not now" is not overridden by go-live.
 */
export async function ensureHelpTrackingPermissions(): Promise<{
  location: PermissionState | "limited";
  backgroundLocation: PermissionState | "limited";
  notifications: PermissionState | "limited";
}> {
  const location = await ensureNativePermission("location", "explicit");
  const backgroundLocation = await ensureNativePermission("backgroundLocation", "explicit");
  const notifications = await ensureNativePermission("notifications", "passive");
  return { location, backgroundLocation, notifications };
}

/**
 * Merge a just-finished request callback into live OS statuses.
 * Only marks the requested kind granted when the OS callback itself returned
 * granted/limited — never on dialog dismissal alone (prompt/denied).
 */
export function applyPermissionRequestResult(
  live: NativePermissionStatuses,
  kind: NativePermissionKind,
  requestResult: PermissionState | "limited",
): NativePermissionStatuses {
  if (isPermissionGranted(requestResult)) {
    return { ...live, [kind]: requestResult };
  }
  // Dismissal / deny: keep live for other kinds, but force this kind non-granted
  // even if a racy checkPermissions briefly reports granted mid-dialog.
  const forced: PermissionState | "limited" =
    requestResult === "denied" ? "denied" : "prompt";
  return { ...live, [kind]: forced };
}
