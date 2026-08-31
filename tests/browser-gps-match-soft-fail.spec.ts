import { test, expect, type Page } from "@playwright/test";
import { APP_URL, prepareAndCompleteOtp } from "./helpers/browser-setup";
import { ensureRegAvailabilityReady } from "./helpers/regAvailability";
import { submitWizardAfterBusinessStep } from "./helpers/wizardSubmit";
import {
  supabaseAdmin,
  deleteVendorRegistrationArtifacts,
  getFirstActiveCategory,
} from "./helpers/setup";

const SHOP = { lat: 18.5204, lng: 73.8567, accuracy: 20 };
/** ~511m north of SHOP — exceeds 75m floor with good accuracy. */
const FAR = { lat: 18.5250, lng: 73.8567, accuracy: 20 };

async function enableE2eMocks(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function setE2eGeo(
  page: Page,
  geo: { lat: number; lng: number; accuracy: number },
) {
  await page.evaluate((g) => {
    (
      window as unknown as {
        __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
      }
    ).__E2E_MOCK_GEO__ = g;
  }, geo);
}

test.describe("GPS match soft-fail + failure logging", () => {
  test.describe.configure({ timeout: 180_000 });
  const phone = `99006${Date.now().toString().slice(-5)}`;
  let vendorId: string | null = null;

  test.afterAll(async () => {
    if (vendorId) {
      await deleteVendorRegistrationArtifacts(vendorId);
    }
  });

  test("GPS-SOFT-01: failed attempts are logged; soft-fail after 2 failures", async ({
    page,
  }) => {
    const cat = await getFirstActiveCategory();
    expect(cat?.id).toBeTruthy();

    const before = await supabaseAdmin
      .from("gps_match_failures")
      .select("id", { count: "exact", head: true });
    const beforeCount = before.count ?? 0;

    await enableE2eMocks(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);
    await expect(page.getByTestId("vendor-registration-wizard")).toBeVisible({
      timeout: 20000,
    });

    await setE2eGeo(page, SHOP);

    await page.getByPlaceholder("Ramesh Kumar").fill("Gps Soft Fail");
    await page.getByPlaceholder("+91 98xxxxxxxx").fill(phone);
    await page.getByTestId("reg-selfie-capture").click();
    await expect(page.getByTestId("reg-selfie-capture")).toContainText(
      /Retake|Re-shoot|फिर|पुन्हा/i,
      { timeout: 15000 },
    );
    await prepareAndCompleteOtp(page, phone, () =>
      page.getByRole("button", { name: "Next" }).click(),
    );

    await page.getByRole("button", { name: "Browse all categories" }).click();
    await page.getByRole("button").filter({ hasText: cat!.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page
      .getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i)
      .fill(`GPS Soft ${Date.now().toString().slice(-4)}`);
    await page
      .getByRole("button", {
        name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन|📍 Capture|Location set/,
      })
      .click();
    await page.getByPlaceholder("name@okbank").fill("gpssoft@okaxis");
    await page.getByRole("button", { name: /At my place|मेरे पास/ }).click();
    await ensureRegAvailabilityReady(page);

    await setE2eGeo(page, FAR);

    // Failure 1
    await page.getByTestId("reg-shop-photo-capture").click();
    await expect(page.getByText(/Location mismatch|लोकेशन/i).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("reg-gps-submit-for-review")).toHaveCount(0);

    // Failure 2 — soft-fail CTA appears
    await page.getByTestId("reg-shop-photo-capture").click();
    await expect(page.getByTestId("reg-gps-submit-for-review")).toBeVisible({
      timeout: 15000,
    });

    await expect
      .poll(
        async () => {
          const { count } = await supabaseAdmin
            .from("gps_match_failures")
            .select("id", { count: "exact", head: true });
          return (count ?? 0) - beforeCount;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(2);

    const { data: recent } = await supabaseAdmin
      .from("gps_match_failures")
      .select("distance_meters, effective_tolerance, source")
      .eq("source", "registration")
      .order("created_at", { ascending: false })
      .limit(5);
    expect((recent ?? []).some((r) => Number(r.distance_meters) > 75)).toBe(true);

    // Soft-fail path (3rd action after 2 failures)
    await page.getByTestId("reg-gps-submit-for-review").click();
    await expect(page.getByTestId("reg-gps-pending-review-note")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("reg-shop-photo-capture")).toContainText(
      /Re-shoot|Reshoot|फिर|पुन्हा/i,
      { timeout: 10000 },
    );

    await submitWizardAfterBusinessStep(page);
    await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 60000 });

    const { data: vendor } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();
    expect(vendor?.id).toBeTruthy();
    vendorId = vendor!.id;

    const { data: vc } = await supabaseAdmin
      .from("vendor_categories")
      .select("verification_status, gps_match_distance, location_accuracy, photo_accuracy")
      .eq("vendor_id", vendorId)
      .eq("category_id", cat!.id)
      .maybeSingle();
    expect(vc?.verification_status).toBe("pending_location_review");
    expect(Number(vc?.gps_match_distance ?? 0)).toBeGreaterThan(75);
  });
});
