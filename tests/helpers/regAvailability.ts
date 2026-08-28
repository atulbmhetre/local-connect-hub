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

  const threeWay = page.getByTestId(`${testIdPrefix}-choice-urgent`);
  if (await threeWay.isVisible().catch(() => false)) {
    if (wantsHelp && wantsAppointment) {
      await page.getByTestId(`${testIdPrefix}-choice-both`).click();
    } else if (wantsHelp) {
      await page.getByTestId(`${testIdPrefix}-choice-urgent`).click();
    } else if (wantsAppointment) {
      await page.getByTestId(`${testIdPrefix}-choice-scheduled`).click();
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
  }
}

/** Ensure at least one valid mode is selected (for tests that only need to proceed). */
export async function ensureRegAvailabilityReady(
  page: Page,
  testIdPrefix = "reg-avail",
) {
  const urgent = page.getByTestId(`${testIdPrefix}-choice-urgent`);
  if (await urgent.isVisible().catch(() => false)) {
    const bothChecked = await page
      .getByTestId(`${testIdPrefix}-choice-both`)
      .getAttribute("aria-checked");
    const urgentChecked = await urgent.getAttribute("aria-checked");
    const scheduledChecked = await page
      .getByTestId(`${testIdPrefix}-choice-scheduled`)
      .getAttribute("aria-checked");
    if (bothChecked === "true" || urgentChecked === "true" || scheduledChecked === "true") {
      return;
    }
    await urgent.click();
    return;
  }
  if (await page.getByTestId(`${testIdPrefix}-deliver-yes`).isVisible().catch(() => false)) {
    await page.getByTestId(`${testIdPrefix}-deliver-yes`).click();
  }
}
