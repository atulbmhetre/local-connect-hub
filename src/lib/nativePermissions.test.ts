import { describe, expect, it } from "vitest";
import {
  applyPermissionRequestResult,
  DEFAULT_NATIVE_PERMISSION_STATUSES,
  isPermissionGranted,
  type NativePermissionStatuses,
} from "@/lib/nativePermissions";
import { strings } from "@/lib/strings";

describe("nativePermissions", () => {
  const liveGranted: NativePermissionStatuses = {
    notifications: "granted",
    location: "prompt",
    camera: "granted",
    microphone: "prompt",
  };

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

    // Dialog dismissal (prompt) must not leave a stale/racy granted check as ✅
    const afterDismiss = applyPermissionRequestResult(liveGranted, "camera", "prompt");
    expect(afterDismiss.camera).toBe("prompt");
    expect(afterDismiss.notifications).toBe("granted");

    const afterDeny = applyPermissionRequestResult(liveGranted, "camera", "denied");
    expect(afterDeny.camera).toBe("denied");
  });
});

describe("Clear All Data copy — OS-managed permissions", () => {
  it("EN/HI/MR clear-data description states permissions are OS-managed and not cleared", () => {
    for (const lang of ["en", "hi", "mr"] as const) {
      const body = strings[lang].settings_clearDataDescription.toLowerCase();
      expect(body).toMatch(/permission|अनुमति|परवानग/);
      expect(body).toMatch(/android/);
      // Must not claim we clear OS permissions
      expect(body).not.toMatch(/clears? (your )?permissions|permissions? (are |is )?cleared/);
    }
    expect(strings.en.settings_clearDataDescription).toMatch(/not cleared here/i);
  });
});
