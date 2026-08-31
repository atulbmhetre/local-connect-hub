import { expect, type Page } from "@playwright/test";

const REGISTER_ME = /Register me|मुझे रजिस्टर|नोंदणी/i;

/**
 * Finish wizard Step B after shop photo.
 * 2-page (generic / no license): click Register me.
 * 3-page (approved specific license): Next → Skip (do not fill license fields).
 * Skip is type=submit, so it completes registration.
 */
export async function submitWizardAfterBusinessStep(page: Page) {
  const nextBtn = page.getByTestId("reg-business-next");
  const registerBtn = page.getByRole("button", { name: REGISTER_ME });

  await expect(nextBtn.or(registerBtn)).toBeVisible({ timeout: 10000 });

  if (await nextBtn.isVisible()) {
    await expect(nextBtn).toBeEnabled({ timeout: 10000 });
    await nextBtn.click();
    const skip = page.getByTestId("reg-license-skip");
    await expect(skip).toBeVisible({ timeout: 10000 });
    await skip.click();
    return;
  }

  await expect(registerBtn).toBeEnabled({ timeout: 10000 });
  await registerBtn.click();
}

/**
 * Finish Add Business after shop photo.
 * No license: click Save/submit on page 1.
 * Approved specific license: Next → Skip (do not fill license fields).
 */
export async function submitAddBusinessAfterForm(page: Page) {
  const nextBtn = page.getByTestId("add-business-next");
  const submitBtn = page.getByTestId("add-business-submit");

  await expect(nextBtn.or(submitBtn)).toBeVisible({ timeout: 15000 });

  if (await nextBtn.isVisible()) {
    await expect(nextBtn).toBeEnabled({ timeout: 15000 });
    await nextBtn.click();
    const skip = page.getByTestId("add-business-license-skip");
    await expect(skip).toBeVisible({ timeout: 10000 });
    await skip.click();
    return;
  }

  await expect(submitBtn).toBeEnabled({ timeout: 15000 });
  await submitBtn.click();
}
