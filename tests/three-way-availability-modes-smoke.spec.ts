/**
 * Live proof: register three Mechanic vendors with Urgent / Scheduled / Both
 * and confirm vendor_category_modes matches each choice.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/three-way-availability-modes-smoke.spec.ts --retries=0
 */
import { expect, test, type Page } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import {
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
  supabaseAdmin,
} from "./helpers/setup";
import { setRegAvailabilityModes } from "./helpers/regAvailability";
import { loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const SESSION = `twa${Date.now().toString().slice(-8)}`;
const observations: string[] = [];
const vendorIds: string[] = [];

async function mockVendorGeolocation(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

test.afterAll(async () => {
  for (const id of vendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  console.log("TWA_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

async function registerMechanicWithModes(
  page: Page,
  modes: Array<"help" | "appointment">,
  tag: string,
) {
  const mechanic = await getActiveCategoryByLabel("Mechanic");
  const phone = `9922${Date.now().toString().slice(-6)}`;
  const brand = `!TWA-${tag}-${SESSION}`;

  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await page.getByPlaceholder("Ramesh Kumar").fill(`TWA ${tag}`);
  await page.getByPlaceholder("+91 98xxxxxxxx").fill(phone);
  await page.getByTestId("reg-selfie-capture").click();
  await expect(page.getByTestId("reg-selfie-capture")).toContainText(/Retake|Re-shoot/i, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Step 2|चरण 2|पायरी 2/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Browse all categories|सभी categories|सर्व categories/i }).click();
  await page.getByRole("button").filter({ hasText: mechanic.label }).first().click();
  await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
  await page
    .getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i)
    .fill(brand);
  await page
    .getByRole("button", {
      name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 Capture|Location set/,
    })
    .click();
  await page.getByPlaceholder("name@okbank").fill("twa@upi");
  await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();

  // Nothing pre-selected
  await expect(page.getByTestId("reg-avail-choice-urgent")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("reg-avail-choice-scheduled")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("reg-avail-choice-both")).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await setRegAvailabilityModes(page, modes);

  await page.getByTestId("reg-shop-photo-capture").click();
  await expect(page.getByTestId("reg-shop-photo-capture")).toContainText(/Re-shoot/i, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /Register me/i }).click();
  await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 25_000 });

  const { data: vendor } = await supabaseAdmin
    .from("vendors")
    .select("id")
    .eq("phone", phone)
    .single();
  expect(vendor?.id).toBeTruthy();
  vendorIds.push(vendor!.id);

  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("id")
    .eq("vendor_id", vendor!.id)
    .eq("category_id", mechanic.id)
    .single();
  const { data: modeRows } = await supabaseAdmin
    .from("vendor_category_modes")
    .select("mode")
    .eq("vendor_category_id", vc!.id);
  const got = (modeRows ?? []).map((m) => m.mode).sort();
  observations.push(`${tag}: phone=${phone} modes=${JSON.stringify(got)}`);
  return got;
}

test("three-way availability writes exact vendor_category_modes for each choice", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await mockVendorGeolocation(page);
  await enableE2eCameraMock(page);

  const urgent = await registerMechanicWithModes(page, ["help"], "U");
  expect(urgent).toEqual(["help"]);

  const scheduled = await registerMechanicWithModes(page, ["appointment"], "S");
  expect(scheduled).toEqual(["appointment"]);

  const both = await registerMechanicWithModes(page, ["help", "appointment"], "B");
  expect(both).toEqual(["appointment", "help"]);

  console.log("TWA_SMOKE_OK", { urgent, scheduled, both });
});
