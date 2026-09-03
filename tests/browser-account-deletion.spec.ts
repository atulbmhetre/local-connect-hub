import { test, expect, type Page } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  createTestVendor,
  cleanupTestData, cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import {
  cleanupBrowserSession38Data,
  supabaseAdmin,
  uniqueTestPhone,
} from './helpers/session38';

const TEST_DEVICE_ID = `device_del_browser_${TEST_SESSION}`;
const CUSTOMER_PHONE = uniqueTestPhone('88012');
const VENDOR_PHONE = uniqueTestPhone('99012');

let testVendor: { id: string; phone: string };

async function openSettingsDeleteSection(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await page.waitForSelector('[data-testid="settings-screen"]', { timeout: 20000 });
  const deleteBtn = page.getByRole('button', { name: 'Delete Account' });
  await deleteBtn.scrollIntoViewIfNeeded();
  await expect(deleteBtn).toBeVisible({ timeout: 5000 });
  return deleteBtn;
}

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  // Service-role client: the anon client's vendors UPDATE is silently blocked
  // by RLS (0 rows), leaving the vendor on its random registration phone while
  // the tests log in as VENDOR_PHONE — phone-based deletion checks then miss.
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ phone: VENDOR_PHONE })
    .eq('id', testVendor.id);
  if (error) throw new Error(`DEL seed: failed to set vendor phone: ${error.message}`);

  const { data: seeded } = await supabaseAdmin
    .from('vendors')
    .select('phone')
    .eq('id', testVendor.id)
    .single();
  if (seeded?.phone !== VENDOR_PHONE) {
    throw new Error(`DEL seed: vendor phone is '${seeded?.phone}', expected '${VENDOR_PHONE}'`);
  }
  testVendor = { ...testVendor, phone: VENDOR_PHONE };
});

test.afterEach(async () => {
  await cleanupBrowserSession38Data([CUSTOMER_PHONE, VENDOR_PHONE], [TEST_DEVICE_ID]);
  await supabaseAdmin
    .from('users')
    .update({ deletion_requested_at: null })
    .eq('phone', VENDOR_PHONE);
  await supabaseAdmin
    .from('vendors')
    .update({ deletion_requested_at: null, is_banned: false, phone: VENDOR_PHONE })
    .eq('id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('DEL-01: settings page shows Delete Account button at bottom', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({ phone: CUSTOMER_PHONE, total_orders: 0 }, { onConflict: 'phone' });
  await loginAsCustomer(page, CUSTOMER_PHONE, TEST_DEVICE_ID);

  const deleteBtn = await openSettingsDeleteSection(page);
  await expect(deleteBtn).toBeVisible();
});

test('DEL-02: Delete Account opens confirmation dialog with correct copy', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({ phone: CUSTOMER_PHONE, total_orders: 0 }, { onConflict: 'phone' });
  await loginAsCustomer(page, CUSTOMER_PHONE, TEST_DEVICE_ID);

  const deleteBtn = await openSettingsDeleteSection(page);
  await deleteBtn.click();

  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Delete your account?')).toBeVisible();
  await expect(
    page.getByText(
      'This will schedule deletion of your account in 30 days. You can cancel from Settings on any device linked to this phone.',
    ),
  ).toBeVisible();
});

test('DEL-03: Cancel on dialog closes it without deleting account', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({ phone: CUSTOMER_PHONE, total_orders: 0 }, { onConflict: 'phone' });
  await loginAsCustomer(page, CUSTOMER_PHONE, TEST_DEVICE_ID);

  const deleteBtn = await openSettingsDeleteSection(page);
  await deleteBtn.click();
  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Delete Account' })).toBeVisible();

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('phone')
    .eq('phone', CUSTOMER_PHONE)
    .maybeSingle();
  expect(user?.phone).toBe(CUSTOMER_PHONE);
});

test('DEL-04: customer Yes Delete shows spinner, toast, and reloads to fresh state', async ({ page }) => {
  await supabaseAdmin.from('users').upsert(
    { phone: CUSTOMER_PHONE, total_orders: 1 },
    { onConflict: 'phone' },
  );
  await supabaseAdmin.from('user_devices').insert({
    user_phone: CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    fcm_token: `fcm_${CUSTOMER_PHONE}`,
  });

  await page.route('**/functions/v1/delete-account', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, TEST_DEVICE_ID);
  const deleteBtn = await openSettingsDeleteSection(page);
  await deleteBtn.click();
  await page.getByRole('button', { name: 'Yes, Delete' }).click();

  await expect(page.locator('section .animate-spin').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-sonner-toast]').getByText('Deletion scheduled', { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(/Account deletion scheduled/i)).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Cancel Deletion' })).toBeVisible();

  const phoneAfter = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(phoneAfter).toBe(CUSTOMER_PHONE);
});

test('DEL-05: vendor Yes Delete shows spinner, toast, and scheduled deletion UI', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({ phone: VENDOR_PHONE, total_orders: 0 }, { onConflict: 'phone' });
  await loginAsVendor(page, VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);

  await page.route('**/functions/v1/delete-account', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  const deleteBtn = await openSettingsDeleteSection(page);
  await deleteBtn.click();
  await page.getByRole('button', { name: 'Yes, Delete' }).click();

  await expect(page.locator('section .animate-spin').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-sonner-toast]').getByText('Deletion scheduled', { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(/Account deletion scheduled/i)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/\d{2} \w{3,4} \d{4}/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Deletion' })).toBeVisible();

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('phone, deletion_requested_at')
    .eq('id', testVendor.id)
    .single();
  expect(vendor.phone).toBe(VENDOR_PHONE);
  expect(vendor.deletion_requested_at).not.toBeNull();
});

test('DEL-06: vendor Cancel Deletion restores normal Delete Account button', async ({ page }) => {
  await supabaseAdmin.from('users').upsert(
    { phone: VENDOR_PHONE, total_orders: 0, deletion_requested_at: new Date().toISOString() },
    { onConflict: 'phone' },
  );
  await supabaseAdmin
    .from('vendors')
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq('id', testVendor.id);
  // The delete-account edge function's cancel action verifies device-phone
  // ownership (deviceOwnsPhone). The real delete flow creates this link via
  // ensureUserDeviceLink; since we seed deletion_requested_at directly, seed
  // the link too or the cancel is rejected with device_not_associated.
  const { error: linkError } = await supabaseAdmin.from('user_devices').insert({
    user_phone: VENDOR_PHONE,
    device_id: TEST_DEVICE_ID,
    fcm_token: `fcm_${VENDOR_PHONE}`,
  });
  if (linkError) throw new Error(`DEL-06 seed: user_devices link failed: ${linkError.message}`);

  await loginAsVendor(page, VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });

  const cancelBtn = page.getByRole('button', { name: 'Cancel Deletion' });
  await cancelBtn.scrollIntoViewIfNeeded();
  await expect(cancelBtn).toBeVisible({ timeout: 8000 });
  await cancelBtn.click();

  await expect(page.getByText('Deletion cancelled')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Delete Account' })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Account deletion scheduled/i)).not.toBeVisible();

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('id', testVendor.id)
    .single();
  expect(vendor.deletion_requested_at).toBeNull();
});
