import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIREBASE_WEB_CONFIG, getFirebaseVapidKey, isWebPushConfigReady } from "@/lib/firebaseWebConfig";

describe("Firebase web push config", () => {
  it("uses the Firebase Web app id, not the Android placeholder", () => {
    expect(FIREBASE_WEB_CONFIG.appId).toContain(":web:");
    expect(FIREBASE_WEB_CONFIG.appId).not.toContain(":android:");
    expect(isWebPushConfigReady()).toBe(true);
    expect(getFirebaseVapidKey().length).toBeGreaterThan(20);
  });

  it("keeps firebase-messaging-sw.js on the same Web app config", () => {
    const sw = readFileSync(resolve("public/firebase-messaging-sw.js"), "utf8");
    expect(sw).toContain(FIREBASE_WEB_CONFIG.appId);
    expect(sw).toContain(FIREBASE_WEB_CONFIG.apiKey);
    expect(sw).toContain(FIREBASE_WEB_CONFIG.messagingSenderId);
    expect(sw).not.toMatch(/:android:/);
  });
});
