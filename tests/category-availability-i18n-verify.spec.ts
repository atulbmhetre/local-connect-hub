import { test, expect, type Page } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import { getActiveCategoryByLabel } from "./helpers/setup";
import path from "node:path";
import fs from "node:fs";

const OUT_DIR = path.join(process.cwd(), "tmp", "i18n-availability-screenshots");

async function mockVendorGeolocation(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function setAppLanguage(page: Page, lang: "hi" | "mr") {
  await page.addInitScript((l) => {
    localStorage.setItem("aaspaas:language", l);
  }, lang);
}

async function completeStepA(page: Page, phone: string, lang: "hi" | "mr") {
  await page.getByPlaceholder("Ramesh Kumar").fill("I18n Owner");
  await page.getByPlaceholder("+91 98xxxxxxxx").fill(phone);
  await page.getByTestId("reg-selfie-capture").click();
  await expect(page.getByTestId("reg-selfie-capture")).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  const nextLabel = lang === "hi" ? "आगे" : "पुढे";
  await page.getByRole("button", { name: nextLabel, exact: true }).click();
  const step2Marker = lang === "hi" ? /चरण 2\/2/ : /पायरी 2\/2/;
  await expect(page.getByText(step2Marker)).toBeVisible({ timeout: 10000 });
}

test.describe("Category availability i18n on-screen verification", () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  test("CAV-I18N-HI: Mechanic + Grocery render Hindi strings", async ({ page }) => {
    const mechanic = await getActiveCategoryByLabel("Mechanic");
    const grocery = await getActiveCategoryByLabel("Grocery Store");

    await enableE2eCameraMock(page);
    await mockVendorGeolocation(page);
    await setAppLanguage(page, "hi");

    await page.goto(`${APP_URL}/vendor`);

    await completeStepA(page, `99198${Date.now().toString().slice(-5)}`, "hi");
    await page.getByText("सभी categories देखें", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: mechanic.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Tyre|टायर/i).fill("HI Mech Shop");
    await page.getByRole("button", { name: /मेरे पास|At my place/i }).click();
    const helpStatement = page.getByTestId("reg-avail-choice-urgent");
    await expect(helpStatement).toBeVisible();
    await expect(page.getByText("इस व्यवसाय के लिए आप अनुरोध कैसे लेते हैं?")).toBeVisible();
    await expect(page.getByText("ग्राहक आप तक कैसे पहुँचें?")).toBeVisible();
    await expect(page.getByTestId("reg-avail-choice-urgent")).toContainText("सिर्फ तुरंत");
    await expect(page.getByTestId("reg-avail-choice-scheduled")).toContainText("निर्धारित");
    await expect(page.getByTestId("reg-avail-choice-both")).toContainText("दोनों");
    await page.screenshot({
      path: path.join(OUT_DIR, "hi-mechanic-availability.png"),
      fullPage: true,
    });

    // Grocery (delivery-default)
    await page.goto(`${APP_URL}/vendor`);
    await completeStepA(page, `99197${Date.now().toString().slice(-5)}`, "hi");
    await page.getByText("सभी categories देखें", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: grocery.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Tyre|टायर/i).fill("HI Groc Shop");
    await page.getByRole("button", { name: /मेरे पास|At my place/i }).click();

    await expect(page.getByText("क्या आप डिलीवरी करते हैं, या सिर्फ दुकान से लेना होता है?")).toBeVisible();
    await expect(page.getByTestId("reg-avail-deliver-yes")).toContainText("हाँ, हम डिलीवरी करते हैं");
    await expect(page.getByTestId("reg-avail-pickup-only")).toContainText("सिर्फ दुकान से लेना");
    await expect(page.getByTestId("reg-avail-choice-urgent")).toHaveCount(0);
    await page.screenshot({
      path: path.join(OUT_DIR, "hi-grocery-availability.png"),
      fullPage: true,
    });
  });

  test("CAV-I18N-MR: Mechanic + Grocery render Marathi strings", async ({ page }) => {
    const mechanic = await getActiveCategoryByLabel("Mechanic");
    const grocery = await getActiveCategoryByLabel("Grocery Store");

    await enableE2eCameraMock(page);
    await mockVendorGeolocation(page);
    await setAppLanguage(page, "mr");
    await page.goto(`${APP_URL}/vendor`);

    await completeStepA(page, `99196${Date.now().toString().slice(-5)}`, "mr");
    await page.getByText("सर्व categories पहा", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: mechanic.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Tyre|टायर/i).fill("MR Mech Shop");
    await page.getByRole("button", { name: /माझ्या जागी|At my place/i }).click();

    const helpStatement = page.getByTestId("reg-avail-choice-urgent");
    await expect(helpStatement).toBeVisible();
    await expect(page.getByText("या व्यवसायासाठी तुम्ही विनंत्या कशा घेता?")).toBeVisible();
    await expect(page.getByText("ग्राहक तुम्हाला कुठे भेटू शकतात?")).toBeVisible();
    await expect(page.getByTestId("reg-avail-choice-urgent")).toContainText("तातडीचे");
    await expect(page.getByTestId("reg-avail-choice-scheduled")).toContainText("नियोजित");
    await expect(page.getByTestId("reg-avail-choice-both")).toContainText("दोन्ही");
    await page.screenshot({
      path: path.join(OUT_DIR, "mr-mechanic-availability.png"),
      fullPage: true,
    });

    await page.goto(`${APP_URL}/vendor`);
    await completeStepA(page, `99195${Date.now().toString().slice(-5)}`, "mr");
    await page.getByText("सर्व categories पहा", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: grocery.label }).first().click();
    await page.locator("button").filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Tyre|टायर/i).fill("MR Groc Shop");
    await page.getByRole("button", { name: /माझ्या जागी|At my place/i }).click();

    await expect(page.getByText("तुम्ही डिलिव्हरी करता का, की फक्त दुकानातून घेणे?")).toBeVisible();
    await expect(page.getByTestId("reg-avail-deliver-yes")).toContainText("होय, आम्ही डिलिव्हरी करतो");
    await expect(page.getByTestId("reg-avail-pickup-only")).toContainText("फक्त दुकानातून घेणे");
    await expect(page.getByTestId("reg-avail-choice-urgent")).toHaveCount(0);
    await page.screenshot({
      path: path.join(OUT_DIR, "mr-grocery-availability.png"),
      fullPage: true,
    });
  });
});
