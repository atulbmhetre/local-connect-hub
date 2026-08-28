/**
 * Phase 8 live smoke (TEST): empty-SOS CategoryPicker is mode-grouped;
 * Painter appears under Appointment (Phase 1 corrected default).
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase8-category-picker-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import { getServiceRoleClient, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const SESSION = `p8c${Date.now().toString().slice(-8)}`;
const DEVICE = `p8_picker_device_${SESSION}`;
const admin = getServiceRoleClient();
const observations: string[] = [];

test.afterAll(async () => {
  console.log("P8_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("Phase 8: empty-SOS picker groups by mode; Painter under Appointment", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const { data: painter, error } = await admin
    .from("categories")
    .select("id, label, service_mode, is_active")
    .eq("label", "Painter")
    .eq("is_active", true)
    .maybeSingle();
  expect(error, String(error)).toBeNull();
  expect(painter?.service_mode).toBe("appointment");
  observations.push(`DB Painter.service_mode=${painter?.service_mode}`);

  await page.goto(APP_URL);
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("aaspaas:device_id", deviceId);
    localStorage.setItem("aaspaas:welcomed", "true");
  }, DEVICE);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });

  // Empty SOS → CategoryPicker (tap-only browse path)
  await page.getByTestId("home-sos-button").click();
  const picker = page.getByTestId("category-picker");
  await expect(picker).toBeVisible({ timeout: 10_000 });

  await expect(picker.getByTestId("category-picker-mode-help")).toBeVisible();
  await expect(picker.getByTestId("category-picker-mode-delivery")).toBeVisible();
  await expect(picker.getByTestId("category-picker-mode-appointment")).toBeVisible();

  // No free-text search on this sheet
  await expect(picker.locator("input")).toHaveCount(0);

  const headers = await picker.getByTestId("category-picker-mode-header").allTextContents();
  observations.push(`mode headers: ${JSON.stringify(headers)}`);

  const painterOpt = picker.locator(
    '[data-testid="category-picker-option"][data-category-label="Painter"]',
  );
  await expect(painterOpt).toBeVisible();
  await expect(painterOpt).toHaveAttribute("data-service-mode", "appointment");

  const appointmentSection = picker.getByTestId("category-picker-mode-appointment");
  await expect(appointmentSection.locator('[data-category-label="Painter"]')).toBeVisible();
  await expect(
    picker.getByTestId("category-picker-mode-help").locator('[data-category-label="Painter"]'),
  ).toHaveCount(0);

  // Tap navigates to Radar with appointment mode
  await painterOpt.click();
  await expect(page).toHaveURL(/\/radar\?.*q=Painter/i, { timeout: 15_000 });
  await expect(page).toHaveURL(/mode=appointment/);
  observations.push(`navigated ${page.url()}`);

  console.log("P8_SMOKE_OK", { painterMode: painter?.service_mode, url: page.url() });
});
