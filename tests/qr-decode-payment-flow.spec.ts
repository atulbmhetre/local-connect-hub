/**
 * QR decode + PaymentSheet QR tab tests (QRD-*).
 *
 * Fixture: tests/fixtures/upi-qr-okhdfcbank.png encodes
 *   upi://pay?pa=fixture-vendor@okhdfcbank&pn=FixtureShop
 * Generated via qrcode npm package (real decodable bitmap for jsQR).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, APP_URL, prepareAndCompleteOtp } from './helpers/browser-setup';
import {
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { setRegAvailabilityModes } from './helpers/regAvailability';
import { submitWizardAfterBusinessStep } from './helpers/wizardSubmit';

const T = Date.now();
const FIXTURE_PAYEE = 'fixture-vendor@okhdfcbank';
const FIXTURE_QR_IMAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'upi-qr-okhdfcbank.png',
);

const L = {
  uploadQrHint: 'Upload your bank-provided UPI QR code',
  welcome: 'Welcome aboard!',
  payNow: 'Pay Now',
  qrTab: 'QR Code',
  scanInstruction: 'Scan this QR from PhonePe / GPay / any UPI app',
  enterUtr: 'Enter UTR / Transaction ID',
} as const;

/**
 * Wizard has no success toast / decoded-preview. The only decode-success
 * signal is handleUpiQrFile calling setUpi(payeeId). Leave the UPI field
 * empty and wait for that fill; retry the upload if jsQR is slow in headless.
 */
async function uploadQrAndWaitForDecode(page: Page): Promise<void> {
  const wizard = page.getByTestId('vendor-registration-wizard');
  const upiInput = wizard.getByPlaceholder('name@okbank');
  const fileInput = wizard.locator('input[type="file"][accept="image/*"]');
  const attempts = 3;
  const perAttemptMs = 15_000;

  await upiInput.scrollIntoViewIfNeeded();
  await expect(upiInput).toHaveValue('');

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await fileInput.setInputFiles([]);
    await fileInput.setInputFiles(FIXTURE_QR_IMAGE);
    try {
      await expect(upiInput).toHaveValue(FIXTURE_PAYEE, { timeout: perAttemptMs });
      await expect(wizard.getByRole('button', { name: L.uploadQrHint })).toBeEnabled({
        timeout: 10_000,
      });
      return;
    } catch (err) {
      const uploadFailed = page.getByText('QR upload failed');
      if (await uploadFailed.isVisible().catch(() => false)) {
        throw new Error(
          'QRD-01: QR upload failed before decode. vendor-docs must allow authenticated upi-qr/ uploads after OTP.',
        );
      }
      lastError = err;
    }
  }
  throw lastError;
}

test.describe.configure({ timeout: 180_000 });

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99006${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88006${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

type VendorRow = { id: string; phone: string; shop_name: string };

async function seedCustomer(phone: string) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

type VendorWithCategory = VendorRow & { category_id: string };

async function createDeliveryVendor(
  tag: string,
  opts: {
    upi_id?: string;
    upi_qr_url?: string | null;
    upi_qr_payee_id?: string | null;
  } = {},
): Promise<VendorWithCategory> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const upiId = opts.upi_id ?? FIXTURE_PAYEE;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `QRD Vendor ${tag}`,
      shop_name: `!QRD-${tag}-${T}`,
      phone,
      upi_id: upiId,
      upi_qr_url: opts.upi_qr_url ?? null,
      upi_qr_payee_id: opts.upi_qr_payee_id ?? null,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, {
    upi_id: upiId,
    upi_qr_url: opts.upi_qr_url ?? null,
    upi_qr_payee_id: opts.upi_qr_payee_id ?? null,
  });
  createdVendorIds.push(vendor.id);
  return { ...vendor, category_id: category.id };
}

async function seedFulfilledOrderWithUnpaidBill(
  vendorId: string,
  customerPhone: string,
  deviceId: string,
  message: string,
  categoryId: string,
) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      category_id: categoryId,
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const billTotal = 300;
  const { error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
      p_vendor_phone: await vendorPhoneById(vendorId),
    p_customer_phone: customerPhone,
    p_total: billTotal,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'QRD item', quantity: 1, unit_price: billTotal, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);
  return request.id;
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 15000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

function paymentSheet(page: Page): Locator {
  return page.getByTestId('payment-sheet');
}

async function openPaymentSheetForOrder(page: Page, message: string) {
  await orderCard(page, message).getByTestId('my-orders-pay-now-btn').click();
  await expect(paymentSheet(page)).toBeVisible({ timeout: 10000 });
}

async function switchToQrTab(page: Page) {
  await paymentSheet(page).getByRole('button', { name: L.qrTab }).click();
}

async function cleanupVendor(vendorId: string) {
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
}

async function cleanupRequest(requestId: string) {
  await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('QRD-01 — decode succeeds on real QR upload, payee ID stored', async ({ page }) => {
  const phone = nextVendorPhone();
  const category = await getActiveCategoryByServiceMode('delivery');
  const ownerName = 'QRD Fixture Owner';
  const shopName = `QRD Fixture Shop ${T}`;

  try {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
    await page.addInitScript(() => {
      (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
    });

    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);
    await expect(page.getByPlaceholder('Ramesh Kumar')).toBeVisible({ timeout: 20000 });

    // Step A: account (name, phone, selfie)
    await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
    await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
    await page.getByTestId('reg-selfie-capture').click();
    await expect(page.getByTestId('reg-selfie-capture')).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
      timeout: 15000,
    });
    await prepareAndCompleteOtp(page, phone, () =>
      page.getByRole('button', { name: 'Next' }).click(),
    );

    // Step B: business + UPI QR decode + GPS + shop photo → Register
    await page.getByRole('button', { name: 'Browse all categories' }).click();
    await page.getByRole('button').filter({ hasText: category.label }).first().click();
    await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(shopName);
    await page
      .getByRole('button', {
        name: /📍 Capture Shop Location|📍 दुकान|Location set/i,
      })
      .click();
    await uploadQrAndWaitForDecode(page);

    await page.getByRole('button', { name: /At their place|उनके पास/ }).click();
    await page.getByRole('button', { name: '15 km' }).click();
    await setRegAvailabilityModes(page, ['delivery']);
    await page.getByTestId('reg-shop-photo-capture').click();
    await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
      timeout: 15000,
    });
    await submitWizardAfterBusinessStep(page);
    await expect(page.getByText(L.welcome)).toBeVisible({ timeout: 25000 });

    const { data: vendor, error } = await supabaseAdmin
      .from('vendors')
      .select('id, upi_qr_payee_id, upi_qr_url')
      .eq('phone', phone)
      .single();
    expect(error).toBeNull();
    expect(vendor?.upi_qr_payee_id).toBe(FIXTURE_PAYEE);
    expect(vendor?.upi_qr_url).toBeTruthy();

    if (vendor?.id) {
      createdVendorIds.push(vendor.id);
      await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendor.id);
    }
  } finally {
    const { data } = await supabaseAdmin.from('vendors').select('id').eq('phone', phone).maybeSingle();
    if (data?.id && !createdVendorIds.includes(data.id)) {
      await cleanupVendor(data.id);
    }
  }
});

test('QRD-02 — customer sees QR deep-link Pay button when payee ID exists', async ({ page }) => {
  const vendor = await createDeliveryVendor('02', {
    upi_qr_payee_id: FIXTURE_PAYEE,
    upi_qr_url: 'https://example.com/decoy-qr.png',
  });
  const customerPhone = nextCustomerPhone();
  const deviceId = `device_qrd_02_${T}`;
  const msg = `QRD-02 deep link ${T}`;
  const requestId = await seedFulfilledOrderWithUnpaidBill(
    vendor.id,
    customerPhone,
    deviceId,
    msg,
    vendor.category_id,
  );

  try {
    await seedCustomer(customerPhone);
    await loginAsCustomer(page, customerPhone, deviceId);
    await gotoMyOrders(page);
    await openPaymentSheetForOrder(page, msg);
    await switchToQrTab(page);

    const sheet = paymentSheet(page);
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeVisible();
    await expect(sheet.getByText(L.scanInstruction)).not.toBeVisible();
    await expect(sheet.locator('img.h-\\[200px\\]')).not.toBeVisible();
    await expect(sheet.locator('#payment-sheet-utr')).not.toBeVisible();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});

test('QRD-03 — fallback when payee ID is null (static image + immediate UTR)', async ({ page }) => {
  const staticQrUrl = 'https://picsum.photos/seed/qrd-static-qr/200/200';
  const vendor = await createDeliveryVendor('03', {
    upi_qr_url: staticQrUrl,
    upi_qr_payee_id: null,
  });
  const customerPhone = nextCustomerPhone();
  const deviceId = `device_qrd_03_${T}`;
  const msg = `QRD-03 fallback ${T}`;
  const requestId = await seedFulfilledOrderWithUnpaidBill(
    vendor.id,
    customerPhone,
    deviceId,
    msg,
    vendor.category_id,
  );

  try {
    await seedCustomer(customerPhone);
    await loginAsCustomer(page, customerPhone, deviceId);
    await gotoMyOrders(page);
    await openPaymentSheetForOrder(page, msg);
    await switchToQrTab(page);

    const sheet = paymentSheet(page);
    await expect(sheet.locator('img.h-\\[200px\\]')).toBeVisible();
    await expect(sheet.getByText(L.scanInstruction)).toBeVisible();
    await expect(sheet.locator('#payment-sheet-utr')).toBeVisible();
    await expect(sheet.getByLabel(L.enterUtr)).toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).not.toBeVisible();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});
