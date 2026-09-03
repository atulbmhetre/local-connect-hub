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
  // 1280 is `xl`: well is max-w-3xl (768px), docked after the sidebar.
  expect(box!.width).toBeGreaterThan(672);
  expect(box!.width).toBeLessThanOrEqual(768 + 2);
  expect(Math.abs(box!.x - 256)).toBeLessThan(2);

  const pad = await main.evaluate((el) => {
    const s = getComputedStyle(el);
    return { top: s.paddingTop, x: s.paddingLeft };
  });
  expect(pad.top).toBe("32px");
  expect(pad.x).toBe("32px");

  const form = page.locator("[data-testid='home-screen'] form");
  await expect(form).toBeVisible({ timeout: 20000 });
  const formBox = await form.boundingBox();
  expect(formBox).toBeTruthy();
  expect(formBox!.width).toBeGreaterThan(448);
  expect(Math.abs(formBox!.width - (box!.width - 64))).toBeLessThan(4);
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

  const main = page.getByTestId("app-shell-main");
  const pad = await main.evaluate((el) => {
    const s = getComputedStyle(el);
    return { top: s.paddingTop, x: s.paddingLeft, maxWidth: s.maxWidth };
  });
  expect(pad.top).toBe("32px");
  expect(pad.x).toBe("16px");
  expect(["28rem", "448px"]).toContain(pad.maxWidth);
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

test("DESKTOP-LAYOUT-08 — sidebar logo and nav labels share a left edge; rows are py-3", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("desktop-sidebar-logo")).toBeVisible({ timeout: 20000 });

  const logoX = await page.getByTestId("desktop-sidebar-logo").evaluate((el) => {
    const s = getComputedStyle(el);
    return el.getBoundingClientRect().left + parseFloat(s.paddingLeft);
  });
  const navX = await page.getByTestId("desktop-nav-home").evaluate((el) => {
    const s = getComputedStyle(el);
    return el.getBoundingClientRect().left + parseFloat(s.paddingLeft);
  });
  expect(Math.abs(logoX - navX)).toBeLessThan(2);

  const navPadY = await page.getByTestId("desktop-nav-home").evaluate((el) =>
    parseFloat(getComputedStyle(el).paddingTop),
  );
  expect(navPadY).toBe(12);
});

test("DESKTOP-LAYOUT-09 — bottom sheets sit in the content well, not over the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("desktop-nav-notifications")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("desktop-nav-notifications").click();

  const sheet = page.locator("[role='dialog']").last();
  await expect(sheet).toBeVisible({ timeout: 15000 });
  const box = await sheet.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(256 - 1);
  expect(box!.width).toBeLessThanOrEqual(768 + 2);
});

test("DESKTOP-LAYOUT-12 — content well is 672 at lg, 768 from xl, and stays left-docked", async ({
  page,
}) => {
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  const main = page.getByTestId("app-shell-main");
  const form = page.locator("[data-testid='home-screen'] form");
  await expect(form).toBeVisible({ timeout: 20000 });

  const measure = async (width: number) => {
    await page.setViewportSize({ width, height: 800 });
    const well = await main.boundingBox();
    const formBox = await form.boundingBox();
    expect(well).toBeTruthy();
    expect(formBox).toBeTruthy();
    expect(Math.abs(well!.x - 256)).toBeLessThan(2);
    expect(Math.abs(formBox!.width - (well!.width - 64))).toBeLessThan(4);
    return well!.width;
  };

  const lgOnly = await measure(1100);
  expect(lgOnly).toBeGreaterThan(448);
  expect(lgOnly).toBeLessThanOrEqual(672 + 2);

  const xl = await measure(1366);
  expect(xl).toBeGreaterThan(672);
  expect(xl).toBeLessThanOrEqual(768 + 2);

  const twoXl = await measure(1920);
  expect(twoXl).toBeGreaterThan(672);
  expect(twoXl).toBeLessThanOrEqual(768 + 2);
});

test("DESKTOP-LAYOUT-13 — Get the App card sits in the right-hand rail at lg+", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await skipWelcome(page);
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });

  const card = page.getByTestId("get-the-app-card");
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole("heading", { name: "Get the Aaspaas Pro App" })).toBeVisible();
  await expect(card.getByText("Coming soon to Google Play")).toBeVisible();
  await expect(page.getByTestId("get-the-app-contact")).toBeVisible();
  await expect(page.getByTestId("get-the-app-submit")).toHaveText("Notify me");

  const well = page.getByTestId("app-shell-main");
  const [wellBox, cardBox] = await Promise.all([well.boundingBox(), card.boundingBox()]);
  expect(wellBox).toBeTruthy();
  expect(cardBox).toBeTruthy();
  expect(cardBox!.x).toBeGreaterThan(wellBox!.x + wellBox!.width - 2);
  expect(cardBox!.width).toBeLessThanOrEqual(384 + 2);

  await page.getByTestId("get-the-app-contact").fill(`get-app-${Date.now()}@example.com`);
  await page.getByTestId("get-the-app-submit").click();
  await expect(page.getByTestId("get-the-app-success")).toBeVisible({ timeout: 15000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("get-the-app-card")).toBeHidden();
});

test("DESKTOP-LAYOUT-10 — radar locating is full-viewport at lg+ with 16px back offset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await skipWelcome(page);
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    geo.getCurrentPosition = () => undefined;
    geo.watchPosition = () => 0;
  });
  await page.goto(`${APP_URL}/radar`, { waitUntil: "domcontentloaded" });

  const locating = page.getByTestId("radar-locating");
  await expect(locating).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("desktop-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("app-shell-main")).toHaveCount(0);

  const box = await locating.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThan(1000);
  expect(box!.x).toBeLessThan(8);

  const back = locating.locator("button").first();
  const backBox = await back.boundingBox();
  expect(backBox).toBeTruthy();
  expect(backBox!.x).toBeGreaterThanOrEqual(15);
  expect(backBox!.x).toBeLessThan(24);

  const status = page.getByTestId("radar-locating-status");
  const statusBox = await status.boundingBox();
  expect(statusBox).toBeTruthy();
  expect(box!.y + box!.height - (statusBox!.y + statusBox!.height)).toBeLessThan(48);
});

test("DESKTOP-LAYOUT-11 — radar locating below lg keeps phone column, flush back, and bottom-nav gap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipWelcome(page);
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    geo.getCurrentPosition = () => undefined;
    geo.watchPosition = () => 0;
  });
  await page.goto(`${APP_URL}/radar`, { waitUntil: "domcontentloaded" });

  const locating = page.getByTestId("radar-locating");
  await expect(locating).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
  await expect(page.getByTestId("app-shell-main")).toBeVisible();
  await expect(page.getByTestId("bottom-nav-chrome")).toBeVisible();

  const back = locating.locator("button").first();
  const main = page.getByTestId("app-shell-main");
  const [backBox, mainBox] = await Promise.all([back.boundingBox(), main.boundingBox()]);
  expect(backBox).toBeTruthy();
  expect(mainBox).toBeTruthy();
  expect(Math.abs(backBox!.x - (mainBox!.x + 16))).toBeLessThan(3);

  const status = page.getByTestId("radar-locating-status");
  const statusBox = await status.boundingBox();
  const locatingBox = await locating.boundingBox();
  expect(statusBox).toBeTruthy();
  expect(locatingBox).toBeTruthy();
  expect(locatingBox!.y + locatingBox!.height - (statusBox!.y + statusBox!.height)).toBeGreaterThan(80);
});

