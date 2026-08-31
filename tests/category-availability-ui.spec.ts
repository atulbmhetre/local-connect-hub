import { test, expect, type Page } from "@playwright/test";
import { APP_URL, prepareAndCompleteOtp } from "./helpers/browser-setup";
import {
  supabaseAdmin,
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
} from "./helpers/setup";
import { setRegAvailabilityModes } from "./helpers/regAvailability";
import { submitWizardAfterBusinessStep } from "./helpers/wizardSubmit";

test.describe.configure({ timeout: 180_000 });

async function mockVendorGeolocation(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function completeWizardStepA(page: Page, phone: string) {
  await page.getByPlaceholder("Ramesh Kumar").fill("Avail UI Owner");
  await page.getByPlaceholder("+91 98xxxxxxxx").fill(phone);
  await page.getByTestId("reg-selfie-capture").click();
  await expect(page.getByTestId("reg-selfie-capture")).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await prepareAndCompleteOtp(page, phone, () =>
    page.getByRole("button", { name: "Next" }).click(),
  );
}

async function completeWizardStepB(
  page: Page,
  opts: {
    categoryLabel: string;
    modes: Array<"help" | "delivery" | "appointment">;
    brandName: string;
  },
) {
  await page.getByRole("button", { name: "Browse all categories" }).click();
  await page.getByRole("button").filter({ hasText: opts.categoryLabel }).first().click();
  await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
  await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(opts.brandName);
  await page
    .getByRole("button", {
      name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 Capture|Location set/,
    })
    .click();
  await page.getByPlaceholder("name@okbank").fill("availui@upi");
  await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();
  await setRegAvailabilityModes(page, opts.modes);
  await page.getByTestId("reg-shop-photo-capture").click();
  await expect(page.getByTestId("reg-shop-photo-capture")).toContainText(/Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await submitWizardAfterBusinessStep(page);
}

test.describe("Category availability plain-language UI", () => {
  test("CAV-01: Mechanic three-way Both writes help+appointment", async ({
    page,
  }) => {
    const mechanic = await getActiveCategoryByLabel("Mechanic");
    const phone = `99101${Date.now().toString().slice(-5)}`;

    await mockVendorGeolocation(page);
    await enableE2eCameraMock(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);

    await completeWizardStepA(page, phone);

    await page.getByRole("button", { name: "Browse all categories" }).click();
    await page.getByRole("button").filter({ hasText: mechanic.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(`Mech ${phone.slice(-4)}`);
    await page
      .getByRole("button", {
        name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 Capture|Location set/,
      })
      .click();
    await page.getByPlaceholder("name@okbank").fill("availui@upi");
    await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();

    await expect(page.getByTestId("reg-avail-choice-urgent")).toBeVisible();
    await expect(page.getByTestId("reg-avail-choice-urgent")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.getByTestId("reg-avail-deliver-yes")).toHaveCount(0);
    await page.getByTestId("reg-avail-choice-both").click();
    await expect(page.getByTestId("reg-avail-choice-both")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.getByTestId("reg-shop-photo-capture").click();
    await expect(page.getByTestId("reg-shop-photo-capture")).toContainText(/Re-shoot|फिर/i, {
      timeout: 15000,
    });
    await submitWizardAfterBusinessStep(page);
    await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 20000 });

    const { data: vendor } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("phone", phone)
      .single();
    const { data: vc } = await supabaseAdmin
      .from("vendor_categories")
      .select("id")
      .eq("vendor_id", vendor!.id)
      .eq("category_id", mechanic.id)
      .single();
    const { data: modes } = await supabaseAdmin
      .from("vendor_category_modes")
      .select("mode")
      .eq("vendor_category_id", vc!.id);
    expect((modes ?? []).map((m) => m.mode).sort()).toEqual(["appointment", "help"]);

    await deleteVendorRegistrationArtifacts(vendor!.id);
  });

  test("CAV-02: Grocery shows delivery question without urgent help", async ({ page }) => {
    const grocery = await getActiveCategoryByLabel("Grocery Store");
    const phone = `99102${Date.now().toString().slice(-5)}`;

    await mockVendorGeolocation(page);
    await enableE2eCameraMock(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);

    await completeWizardStepA(page, phone);

    await page.getByRole("button", { name: "Browse all categories" }).click();
    await page.getByRole("button").filter({ hasText: grocery.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(`Groc ${phone.slice(-4)}`);
    await page
      .getByRole("button", {
        name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 Capture|Location set/,
      })
      .click();
    await page.getByPlaceholder("name@okbank").fill("availui@upi");
    await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();

    await expect(page.getByTestId("reg-avail-deliver-yes")).toBeVisible();
    await expect(page.getByTestId("reg-avail-choice-urgent")).toHaveCount(0);
    await page.getByTestId("reg-avail-deliver-yes").click();

    await page.getByTestId("reg-shop-photo-capture").click();
    await submitWizardAfterBusinessStep(page);
    await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 20000 });

    const { data: vendor } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("phone", phone)
      .single();
    await deleteVendorRegistrationArtifacts(vendor!.id);
  });

  test("CAV-03: Beautician three-way; scheduled-only writes appointment", async ({ page }) => {
    const beautician = await getActiveCategoryByLabel("Beautician");
    const phone = `99103${Date.now().toString().slice(-5)}`;

    await mockVendorGeolocation(page);
    await enableE2eCameraMock(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);

    await completeWizardStepA(page, phone);

    await page.getByRole("button", { name: "Browse all categories" }).click();
    await page.getByRole("button").filter({ hasText: beautician.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(`Beauty ${phone.slice(-4)}`);
    await page
      .getByRole("button", {
        name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 Capture|Location set/,
      })
      .click();
    await page.getByPlaceholder("name@okbank").fill("availui@upi");
    await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();

    await expect(page.getByTestId("reg-avail-choice-scheduled")).toBeVisible();
    await expect(page.getByTestId("reg-avail-choice-scheduled")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.getByTestId("reg-avail-deliver-yes")).toHaveCount(0);
    await page.getByTestId("reg-avail-choice-scheduled").click();

    await page.getByTestId("reg-shop-photo-capture").click();
    await submitWizardAfterBusinessStep(page);
    await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 20000 });

    const { data: vendor } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("phone", phone)
      .single();
    const { data: vc } = await supabaseAdmin
      .from("vendor_categories")
      .select("id")
      .eq("vendor_id", vendor!.id)
      .eq("category_id", beautician.id)
      .single();
    const { data: modes } = await supabaseAdmin
      .from("vendor_category_modes")
      .select("mode")
      .eq("vendor_category_id", vc!.id);
    expect((modes ?? []).map((m) => m.mode)).toEqual(["appointment"]);

    await deleteVendorRegistrationArtifacts(vendor!.id);
  });
});
