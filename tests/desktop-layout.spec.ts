import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";

test("DESKTOP-LAYOUT-01 — BottomNav chrome stays in the max-w-md column on a wide viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("aaspaas:welcomed", "true");
    localStorage.setItem("aaspaas:device_id", "desktop-layout-device");
  });
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  const chrome = page.getByTestId("bottom-nav-chrome");
  await expect(chrome).toBeVisible({ timeout: 20000 });
  const box = await chrome.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThanOrEqual(448 + 2);
});
