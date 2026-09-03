/**
 * TEST: real Firebase Web FCM token mint + upsert_*_device + notify-user delivery.
 *
 * Playwright's default isolated context is treated as Chrome incognito, which
 * cannot use the Push API. Run explicitly:
 *   npx playwright test tests/web-push-fcm.spec.ts --headed --retries=0
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { loginAsVendor, APP_URL, expandMyAccountAccordion } from "./helpers/browser-setup";
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestVendors,
} from "./helpers/setup";

const T = Date.now();
const DEVICE_ID = `web-push-${T}`;
const TITLE = `Web push TEST ${T}`;
const BODY = `Browser delivery ${T}`;

test.describe("web FCM (real token)", () => {
  test.skip(
    process.env.WEB_PUSH_LIVE !== "1",
    "requires a real Chrome profile (WEB_PUSH_LIVE=1) — default Playwright context is incognito",
  );
  let vendor: { id: string; phone: string };

  test.beforeAll(async () => {
    vendor = await createTestVendor({
      phone: `88081${String(T).slice(-5)}`,
      shop_name: `WebPush ${T}`,
    });
    await createTestCustomer(vendor.phone).catch(() => undefined);
  });

  test.afterAll(async () => {
    await supabaseAdmin.from("user_devices").delete().eq("device_id", DEVICE_ID);
    await supabaseAdmin.from("vendor_devices").delete().eq("device_id", DEVICE_ID);
    await supabaseAdmin.from("fcm_delivery_log").delete().eq("target_phone", vendor.phone);
    await supabaseAdmin.from("user_notifications").delete().eq("user_phone", vendor.phone);
    await supabaseAdmin.from("users").delete().eq("phone", vendor.phone);
    await cleanupTestVendors();
  });

  test("WEB-PUSH-01 — gesture mints a real token, RPCs persist it, notify-user appears, click deep-links", async () => {
    test.setTimeout(120000);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aaspaas-webpush-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "allow",
    });
    const shown: Array<{ title: string; body?: string }> = [];
    const logs: string[] = [];

    try {
      await context.grantPermissions(["notifications"], { origin: APP_URL });
      const page = context.pages()[0] ?? (await context.newPage());
      page.on("console", (msg) => {
        const text = msg.text();
        logs.push(`${msg.type()}: ${text}`);
        if (text.startsWith("__pushShown:")) {
          try {
            shown.push(JSON.parse(text.slice("__pushShown:".length)));
          } catch {
            /* ignore */
          }
        }
      });

      await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);

      const envProbe = await page.evaluate(() => ({
        permission: Notification.permission,
        pushManager: "PushManager" in window,
      }));
      expect(envProbe.pushManager).toBe(true);

      const cfg = await page.evaluate(async () => {
        const m = await import("/src/lib/firebaseWebConfig.ts");
        return {
          ready: m.isWebPushConfigReady(),
          vapidLen: m.getFirebaseVapidKey().length,
          appId: m.FIREBASE_WEB_CONFIG.appId as string,
        };
      });
      expect(cfg.ready, JSON.stringify(cfg)).toBe(true);
      expect(cfg.appId).toContain(":web:");

      await page.goto(`${APP_URL}/settings`);
      await expect(page.getByTestId("settings-screen")).toBeVisible({ timeout: 15000 });
      await expandMyAccountAccordion(page);
      await page.getByTestId("settings-feed-discovery-toggle").click();
      await expect(page.getByTestId("settings-feed-discovery")).toBeVisible();

      const feedSwitch = page.getByTestId("settings-feed-notifications-switch");
      await expect(feedSwitch).toBeVisible();
      if (await feedSwitch.isChecked()) {
        await feedSwitch.click();
        await expect(
          page.getByText(/Announcement & recommendation preference saved/i),
        ).toBeVisible({ timeout: 10000 });
      }
      await feedSwitch.click();
      let minted = false;
      for (let i = 0; i < 3 && !minted; i++) {
        minted = await page.evaluate(async (phone) => {
          const m = await import("/src/lib/webPush.ts");
          return m.requestWebPushFromUserGesture({ userPhone: phone });
        }, vendor.phone);
        if (!minted) await page.waitForTimeout(1500);
      }

      let userToken = "";
      try {
        userToken = await waitForDeviceToken(
          () =>
            supabaseAdmin
              .from("user_devices")
              .select("fcm_token")
              .eq("user_phone", vendor.phone)
              .eq("device_id", DEVICE_ID)
              .maybeSingle(),
          40000,
        );
      } catch (err) {
        const debug = await page.evaluate(async () => {
          const regs = await navigator.serviceWorker.getRegistrations();
          return {
            permission: Notification.permission,
            sw: regs.map((r) => r.active?.scriptURL ?? r.scope),
          };
        });
        throw new Error(
          `${(err as Error).message} debug=${JSON.stringify(debug)} logs=${logs.slice(-25).join(" | ")}`,
        );
      }
      expect(userToken.length).toBeGreaterThan(80);

      await page.goto(`${APP_URL}/vendor`);
      await page.waitForTimeout(2500);

      const vendorToken = await waitForDeviceToken(
        () =>
          supabaseAdmin
            .from("vendor_devices")
            .select("fcm_token")
            .eq("vendor_id", vendor.id)
            .eq("device_id", DEVICE_ID)
            .maybeSingle(),
        20000,
      );
      expect(vendorToken.length).toBeGreaterThan(80);
      expect(userToken).toMatch(/:APA91b/);
      expect(vendorToken).toMatch(/:APA91b/);

      await page.evaluate(() => {
        const NativeNotification = window.Notification;
        class WrappedNotification extends NativeNotification {
          constructor(title: string, options?: NotificationOptions) {
            console.log(
              "__pushShown:" +
                JSON.stringify({ title, body: options?.body, data: options?.data }),
            );
            super(title, options);
          }
        }
        window.Notification = WrappedNotification as unknown as typeof Notification;
      });

      await page.bringToFront();
      const baseline = await countFcmLogs(vendor.phone, "user-order_accepted");
      // Delivery probe — no live request relationship; service-role bypass.
      const { error: notifyErr } = await supabaseAdmin.functions.invoke("notify-user", {
        body: {
          user_phone: vendor.phone,
          title: TITLE,
          body: BODY,
          type: "order_accepted",
          route: "my-orders",
          route_params: { order_id: `webpush-${T}` },
          skip_inbox: true,
        },
      });
      expect(notifyErr, notifyErr?.message).toBeNull();

      const fcmLogs = await waitForFcmSuccess(
        vendor.phone,
        "user-order_accepted",
        baseline,
        15000,
      );
      expect(
        fcmLogs.some((row) => (row.success_count ?? 0) > 0),
        JSON.stringify(fcmLogs.slice(-3)),
      ).toBe(true);

      await expect
        .poll(() => shown.some((n) => n.title === TITLE), { timeout: 20000 })
        .toBe(true);

      await page.goto(
        `${APP_URL}/?push_route=my-orders&push_route_params=${encodeURIComponent(
          JSON.stringify({ order_id: `webpush-${T}` }),
        )}`,
      );
      await expect(page).toHaveURL(/\/my-orders/, { timeout: 15000 });
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

type TokenQuery = PromiseLike<{ data: { fcm_token?: string | null } | null }>;

async function waitForDeviceToken(query: () => TokenQuery, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await query();
    const token = data?.fcm_token?.trim() ?? "";
    if (token.length > 80) return token;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("FCM web token was not persisted in time");
}

async function countFcmLogs(phone: string, type: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("fcm_delivery_log")
    .select("id")
    .eq("target_phone", phone)
    .eq("notification_type", type);
  return data?.length ?? 0;
}

async function waitForFcmSuccess(
  phone: string,
  type: string,
  baseline: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabaseAdmin
      .from("fcm_delivery_log")
      .select("id, success_count, raw_response")
      .eq("target_phone", phone)
      .eq("notification_type", type);
    const rows = data ?? [];
    if (rows.length > baseline && rows.some((r) => (r.success_count ?? 0) > 0)) {
      return rows;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const { data } = await supabaseAdmin
    .from("fcm_delivery_log")
    .select("id, success_count, raw_response")
    .eq("target_phone", phone)
    .eq("notification_type", type);
  return data ?? [];
}
