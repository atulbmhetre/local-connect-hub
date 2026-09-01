import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";

async function skipWelcome(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("aaspaas:welcomed", "true");
    localStorage.setItem("aaspaas:device_id", "desktop-layout-device");
  });
}

test("DESKTOP-LAYOUT-01 — lg+ web shows sidebar, hides bottom nav, and caps content width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });

  const sidebar = page.getByTestId("desktop-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("desktop-nav-home")).toBeVisible();
  await expect(page.getByTestId("desktop-nav-feed")).toBeVisible();
  await expect(page.getByTestId("desktop-nav-orders")).toBeVisible();
  await expect(page.getByTestId("desktop-nav-khata")).toBeVisible();
  await expect(page.getByTestId("desktop-nav-notifications")).toBeVisible();
  await expect(page.getByTestId("desktop-vendor-mode-toggle")).toBeVisible();
  await expect(page.getByTestId("desktop-nav-settings")).toBeVisible();

  await expect(page.getByTestId("bottom-nav-chrome")).toBeHidden();

  const main = page.getByTestId("app-shell-main");
  const box = await main.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThanOrEqual(768 + 2);
  expect(box!.x).toBeGreaterThanOrEqual(240);
});

test("DESKTOP-LAYOUT-02 — below lg the phone column and bottom nav are unchanged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });

  const chrome = page.getByTestId("bottom-nav-chrome");
  await expect(chrome).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("nav-home")).toBeVisible();
  await expect(page.getByTestId("desktop-sidebar")).toBeHidden();

  const box = await chrome.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThanOrEqual(448 + 2);
});

test("DESKTOP-LAYOUT-03 — /tracking stays full-viewport with no sidebar at lg+", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/tracking`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("desktop-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("bottom-nav-chrome")).toHaveCount(0);
  await expect(page.getByTestId("app-shell-main")).toHaveCount(0);
});

test("DESKTOP-LAYOUT-04 — /track/:vendorId stays full-viewport with no sidebar at lg+", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/track/desktop-layout-vendor`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("desktop-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("bottom-nav-chrome")).toHaveCount(0);
  await expect(page.getByTestId("app-shell-main")).toHaveCount(0);
});

test("DESKTOP-LAYOUT-05 — customer Khata goes to /my-orders#khata, not /vendor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("desktop-nav-khata")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("desktop-nav-khata").click();
  await expect(page).toHaveURL(/\/my-orders#khata/);
  await expect(page).not.toHaveURL(/\/vendor/);
  await expect(page.getByTestId("my-orders-khata")).toBeAttached();
});

test("DESKTOP-LAYOUT-06 — header notification bell is hidden at lg+ and visible below lg", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("desktop-nav-notifications")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("notification-bell-btn")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("notification-bell-btn")).toBeVisible();
  await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
});

test("DESKTOP-LAYOUT-07 — Vendor/Orders back-to-home is hidden at lg+ and visible below lg", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/my-orders`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("my-orders-screen")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("my-orders-back-home")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("my-orders-back-home")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP_URL}/vendor`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("vendor-back-home")).toBeHidden({ timeout: 20000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("vendor-back-home")).toBeVisible();
});
