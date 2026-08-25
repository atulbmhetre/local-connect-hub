import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionState } from "@capacitor/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  pushCheck,
  pushRequest,
  pushRegister,
  geoCheck,
  geoRequest,
  camCheck,
  camRequest,
  micCheck,
  micRequest,
  bgCheck,
  bgRequest,
} = vi.hoisted(() => ({
  pushCheck: vi.fn(async (): Promise<{ receive: PermissionState }> => ({ receive: "prompt" })),
  pushRequest: vi.fn(async (): Promise<{ receive: PermissionState }> => ({ receive: "granted" })),
  pushRegister: vi.fn(async () => undefined),
  geoCheck: vi.fn(async (): Promise<{ location: PermissionState }> => ({ location: "prompt" })),
  geoRequest: vi.fn(async (): Promise<{ location: PermissionState }> => ({ location: "granted" })),
  camCheck: vi.fn(async (): Promise<{ camera: PermissionState }> => ({ camera: "prompt" })),
  camRequest: vi.fn(async (): Promise<{ camera: PermissionState }> => ({ camera: "granted" })),
  micCheck: vi.fn(async (): Promise<{ speechRecognition: PermissionState }> => ({
    speechRecognition: "prompt",
  })),
  micRequest: vi.fn(async (): Promise<{ speechRecognition: PermissionState }> => ({
    speechRecognition: "granted",
  })),
  bgCheck: vi.fn(
    async (): Promise<{ backgroundLocation: PermissionState | "always" | "when_in_use" }> => ({
      backgroundLocation: "prompt",
    }),
  ),
  bgRequest: vi.fn(
    async (): Promise<{ backgroundLocation: PermissionState | "always" | "when_in_use" }> => ({
      backgroundLocation: "granted",
    }),
  ),
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: pushCheck,
    requestPermissions: pushRequest,
    register: pushRegister,
  },
}));

vi.mock("@capacitor/geolocation", () => ({
  Geolocation: {
    checkPermissions: geoCheck,
    requestPermissions: geoRequest,
  },
}));

vi.mock("@capacitor/camera", () => ({
  Camera: {
    checkPermissions: camCheck,
    requestPermissions: camRequest,
  },
}));

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    checkPermissions: micCheck,
    requestPermissions: micRequest,
  },
}));

vi.mock("@capgo/background-geolocation", () => ({
  BackgroundGeolocation: {
    checkPermissions: bgCheck,
    requestPermissions: bgRequest,
  },
}));

import {
  applyPermissionRequestResult,
  checkNativePermissionStatuses,
  clearNotificationSkip,
  DEFAULT_NATIVE_PERMISSION_STATUSES,
  ensureHelpTrackingPermissions,
  ensureNativePermission,
  ensureNativePermissionGranted,
  hasNotificationSkip,
  isPermissionGranted,
  markNotificationSkip,
  NOTIF_SKIP_AT_KEY,
  requestNativePermission,
  type NativePermissionStatuses,
} from "@/lib/nativePermissions";
import { strings } from "@/lib/strings";

describe("nativePermissions", () => {
  const liveGranted: NativePermissionStatuses = {
    notifications: "granted",
    location: "prompt",
    backgroundLocation: "prompt",
    camera: "granted",
    microphone: "prompt",
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    pushCheck.mockResolvedValue({ receive: "prompt" });
    pushRequest.mockResolvedValue({ receive: "granted" });
    geoCheck.mockResolvedValue({ location: "prompt" });
    geoRequest.mockResolvedValue({ location: "granted" });
    camCheck.mockResolvedValue({ camera: "prompt" });
    camRequest.mockResolvedValue({ camera: "granted" });
    micCheck.mockResolvedValue({ speechRecognition: "prompt" });
    micRequest.mockResolvedValue({ speechRecognition: "granted" });
    bgCheck.mockResolvedValue({ backgroundLocation: "prompt" });
    bgRequest.mockResolvedValue({ backgroundLocation: "granted" });
  });

  it("isPermissionGranted accepts granted and limited only", () => {
    expect(isPermissionGranted("granted")).toBe(true);
    expect(isPermissionGranted("limited")).toBe(true);
    expect(isPermissionGranted("prompt")).toBe(false);
    expect(isPermissionGranted("denied")).toBe(false);
  });

  it("applyPermissionRequestResult only ticks Allow when OS callback is granted", () => {
    const afterGrant = applyPermissionRequestResult(
      DEFAULT_NATIVE_PERMISSION_STATUSES,
      "camera",
      "granted",
    );
    expect(afterGrant.camera).toBe("granted");

    const afterDismiss = applyPermissionRequestResult(liveGranted, "camera", "prompt");
    expect(afterDismiss.camera).toBe("prompt");
    expect(afterDismiss.notifications).toBe("granted");

    const afterDeny = applyPermissionRequestResult(liveGranted, "camera", "denied");
    expect(afterDeny.camera).toBe("denied");
  });

  it("checkNativePermissionStatuses includes background location", async () => {
    pushCheck.mockResolvedValue({ receive: "granted" });
    geoCheck.mockResolvedValue({ location: "granted" });
    bgCheck.mockResolvedValue({ backgroundLocation: "always" });
    camCheck.mockResolvedValue({ camera: "granted" });
    micCheck.mockResolvedValue({ speechRecognition: "denied" });

    const live = await checkNativePermissionStatuses();
    expect(live).toEqual({
      notifications: "granted",
      location: "granted",
      backgroundLocation: "granted",
      camera: "granted",
      microphone: "denied",
    });
  });

  it("persists FirstOpen notification skip as a timestamp", () => {
    expect(hasNotificationSkip()).toBe(false);
    markNotificationSkip();
    expect(hasNotificationSkip()).toBe(true);
    const raw = localStorage.getItem(NOTIF_SKIP_AT_KEY);
    expect(raw).toBeTruthy();
    expect(Number(raw)).toBeGreaterThan(0);
    clearNotificationSkip();
    expect(hasNotificationSkip()).toBe(false);
  });

  it("passive notification ensure does not prompt after skip", async () => {
    markNotificationSkip();
    const status = await ensureNativePermission("notifications", "passive");
    expect(status).toBe("prompt");
    expect(pushRequest).not.toHaveBeenCalled();
  });

  it("passive notification ensure prompts when never skipped", async () => {
    const granted = await ensureNativePermissionGranted("notifications", "passive");
    expect(granted).toBe(true);
    expect(pushRequest).toHaveBeenCalled();
  });

  it("explicit notification ensure prompts even after skip", async () => {
    markNotificationSkip();
    const granted = await ensureNativePermissionGranted("notifications", "explicit");
    expect(granted).toBe(true);
    expect(pushRequest).toHaveBeenCalled();
    expect(hasNotificationSkip()).toBe(false);
  });

  it("does not re-request when OS already granted", async () => {
    pushCheck.mockResolvedValue({ receive: "granted" });
    const status = await ensureNativePermission("notifications", "passive");
    expect(status).toBe("granted");
    expect(pushRequest).not.toHaveBeenCalled();
  });

  it("does not re-request when OS permanently denied", async () => {
    pushCheck.mockResolvedValue({ receive: "denied" });
    const status = await ensureNativePermission("notifications", "explicit");
    expect(status).toBe("denied");
    expect(pushRequest).not.toHaveBeenCalled();
  });

  it("passive location ensure never prompts", async () => {
    const status = await ensureNativePermission("location", "passive");
    expect(status).toBe("prompt");
    expect(geoRequest).not.toHaveBeenCalled();
  });

  it("go-live help tracking only requests kinds that are still prompt", async () => {
    geoCheck.mockResolvedValue({ location: "granted" });
    bgCheck.mockResolvedValue({ backgroundLocation: "prompt" });
    pushCheck.mockResolvedValue({ receive: "granted" });

    const result = await ensureHelpTrackingPermissions();
    expect(result.location).toBe("granted");
    expect(geoRequest).not.toHaveBeenCalled();
    expect(bgRequest).toHaveBeenCalledWith({ permissions: ["backgroundLocation"] });
    expect(pushRequest).not.toHaveBeenCalled();
  });

  it("go-live does not prompt notifications after FirstOpen Not now", async () => {
    markNotificationSkip();
    pushCheck.mockResolvedValue({ receive: "prompt" });
    geoCheck.mockResolvedValue({ location: "granted" });
    bgCheck.mockResolvedValue({ backgroundLocation: "granted" });
    await ensureHelpTrackingPermissions();
    expect(pushRequest).not.toHaveBeenCalled();
  });

  it("requestNativePermission camera asks camera only", async () => {
    await requestNativePermission("camera");
    expect(camRequest).toHaveBeenCalledWith({ permissions: ["camera"] });
  });
});

describe("Clear All Data copy — OS-managed permissions", () => {
  it("EN/HI/MR clear-data description states permissions are OS-managed and not cleared", () => {
    for (const lang of ["en", "hi", "mr"] as const) {
      const body = [
        strings[lang].settings_clearDataDescription_wiped,
        strings[lang].settings_clearDataDescription_permissions,
        strings[lang].settings_clearDataDescription_kept,
      ]
        .join(" ")
        .toLowerCase();
      expect(body).toMatch(/permission|अनुमति|परवानग/);
      expect(body).toMatch(/order|ऑर्डर/);
      expect(body).toMatch(/khata|खाता|खाते/);
      expect(body).not.toMatch(/clears? (your )?permissions|permissions? (are |is )?cleared/);
    }
    expect(strings.en.settings_clearDataDescription_permissions).toMatch(/aren't touched/i);
  });

  it("Settings clear-data success reuses the OS-permissions copy when notifications stay granted", () => {
    const src = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");
    const resetIdx = src.indexOf("const reset = async () => {");
    const nextFn = src.indexOf("const startEditAddress", resetIdx);
    const resetBody = src.slice(resetIdx, nextFn);
    expect(resetBody).toContain("checkNativePermissionStatuses");
    expect(resetBody).toContain("isPermissionGranted(live.notifications)");
    expect(resetBody).toContain("settings_clearDataDescription_permissions");
    expect(resetBody).toContain("description: notificationNudge");
  });
});

describe("Settings Device revoke guidance", () => {
  it("EN/HI/MR revoke hint points at phone Settings > Apps > Aaspaas Pro > Permissions", () => {
    for (const lang of ["en", "hi", "mr"] as const) {
      const hint = strings[lang].settings_permission_revoke_hint;
      expect(hint).toMatch(/Settings > Apps > Aaspaas Pro > Permissions/);
    }
    expect(strings.en.settings_permission_background_location).toMatch(/background location/i);
    expect(strings.hi.settings_permission_background_location).toBeTruthy();
    expect(strings.mr.settings_permission_background_location).toBeTruthy();
  });
});
