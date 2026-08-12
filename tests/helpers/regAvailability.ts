import type { Page } from "@playwright/test";

/** Set availability modes in the simplified per-catalog registration UI. */
export async function setRegAvailabilityModes(
  page: Page,
  modes: Array<"help" | "delivery" | "appointment">,
  testIdPrefix = "reg-avail",
) {
  const wantsHelp = modes.includes("help");
  const wantsDelivery = modes.includes("delivery");
  const wantsAppointment = modes.includes("appointment");

  const helpOn = page.getByTestId(`${testIdPrefix}-help-on`);
  if (await helpOn.isVisible().catch(() => false)) {
    if (wantsAppointment) {
      await page.getByTestId(`${testIdPrefix}-bookings-yes`).click();
    }
    return;
  }

  const deliverYes = page.getByTestId(`${testIdPrefix}-deliver-yes`);
  if (await deliverYes.isVisible().catch(() => false)) {
    if (wantsDelivery) {
      await deliverYes.click();
    } else {
      await page.getByTestId(`${testIdPrefix}-pickup-only`).click();
    }
    return;
  }

  const appointmentOn = page.getByTestId(`${testIdPrefix}-appointment-on`);
  if (await appointmentOn.isVisible().catch(() => false)) {
    if (wantsHelp) {
      await page.getByTestId(`${testIdPrefix}-same-day-yes`).click();
    }
  }
}

/** Ensure at least one valid mode is selected (for tests that only need to proceed). */
export async function ensureRegAvailabilityReady(
  page: Page,
  testIdPrefix = "reg-avail",
) {
  if (await page.getByTestId(`${testIdPrefix}-help-on`).isVisible().catch(() => false)) {
    return;
  }
  if (await page.getByTestId(`${testIdPrefix}-appointment-on`).isVisible().catch(() => false)) {
    return;
  }
  if (await page.getByTestId(`${testIdPrefix}-deliver-yes`).isVisible().catch(() => false)) {
    await page.getByTestId(`${testIdPrefix}-deliver-yes`).click();
  }
}
