import type { PermissionState } from "@capacitor/core";
import { Camera as CapacitorCamera } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";
import { PushNotifications } from "@capacitor/push-notifications";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";

export type NativePermissionKind = "notifications" | "location" | "camera" | "microphone";

export type NativePermissionStatuses = {
  notifications: PermissionState;
  location: PermissionState;
  camera: PermissionState | "limited";
  microphone: PermissionState;
};

export const DEFAULT_NATIVE_PERMISSION_STATUSES: NativePermissionStatuses = {
  notifications: "prompt",
  location: "prompt",
  camera: "prompt",
  microphone: "prompt",
};

/**
 * Live OS permission snapshot — never cache in localStorage / Preferences.
 * Same idea as Battery Optimization (Manual): the OS is source of truth.
 */
export async function checkNativePermissionStatuses(): Promise<NativePermissionStatuses> {
  const [push, geo, cam, mic] = await Promise.all([
    PushNotifications.checkPermissions(),
    Geolocation.checkPermissions().catch(() => ({ location: "denied" as PermissionState })),
    CapacitorCamera.checkPermissions(),
    SpeechRecognition.checkPermissions().catch(() => ({
      speechRecognition: "denied" as PermissionState,
    })),
  ]);
  return {
    notifications: push.receive,
    location: geo.location,
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
      }
      return result.receive;
    }
    case "location": {
      const result = await Geolocation.requestPermissions();
      return result.location;
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
