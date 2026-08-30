import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorMyBusinessTab, expandFirstMyBusinessCategoryAccordion, APP_URL, prepareAndCompleteOtp, completeOtpIfVisible, prepareUiOtpSend } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_SESSION,
} from './helpers/setup';
import { resolveCancelReasonsForCategory } from '../src/lib/categoryScopedVendor';

test.describe.configure({ timeout: 180_000 });

// Closes out the two confirmed Cancel Reasons bugs:
//  1. Single-category shadowing — Settings previously wrote edits to legacy
//     account-level columns (vendors.cancel_reason_1..4) while the cancel flow
//     resolves category-level rows first, so a stale seed-copied category row
//     silently shadowed every edit. Settings must now read/write the
//     category-level table for any approved category.
//  2. Hidden-vendor logout — VendorMode's no-phone fallback used a direct
//     RLS-gated vendors read that returns null for non-discoverable vendors,
//     which wiped aaspaas:vendor_id and logged the vendor out of their own
//     account. It must now recover via get_vendor_own where possible and
//     never treat "hidden" as "account gone".

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: string): string {
  phoneSeq += 1;
  const phone = `${prefix}${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('requests').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_category_cancel_reasons').delete().eq('vendor_id', id);
    const { data: vcRows } = await supabaseAdmin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', id);
    const vcIds = (vcRows ?? []).map((r) => r.id);
    if (vcIds.length) {
      await supabaseAdmin.from('vendor_category_modes').delete().in('vendor_category_id', vcIds);
    }
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
    await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
  }
});

async function seedVendor(opts: {
  shopName: string;
  category: { id: string; label: string; service_mode: string };
  discoverable?: boolean;
  extra?: Record<string, unknown>;
}) {
  const phone = nextPhone('99071');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Cancel Closeout Owner',
      shop_name: opts.shopName,
      phone,
      category: opts.category.label,
      service_mode: opts.category.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: opts.discoverable ?? true,
      vendor_note: `test_session:${TEST_SESSION}`,
      ...(opts.extra ?? {}),
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, opts.category, { is_primary: true });
  await seedDefaultVendorVerification(vendor.id);
  return vendor as { id: string; phone: string };
}

test('CR-SHADOW-01 — single-category My Business edit writes category rows and is used on vendor cancel', async ({
  page,
}) => {
  const help = await getActiveCategoryByServiceMode('help');
  const vendor = await seedVendor({
    shopName: `!CR-SHADOW-${T}`,
    category: help,
    extra: {
      cancel_reason_1: 'Account reason one',
      cancel_reason_2: 'Account reason two',
    },
  });

  // Stale seed-copied category-level row — this previously shadowed all edits.
  const { error: seedErr } = await supabaseAdmin
    .from('vendor_category_cancel_reasons')
    .insert([
      { vendor_id: vendor.id, category_id: help.id, reason_text: 'Category stale reason', position: 1 },
      { vendor_id: vendor.id, category_id: help.id, reason_text: 'Category stale second', position: 2 },
    ]);
  expect(seedErr, seedErr?.message).toBeNull();

  await loginAsVendor(page, vendor.phone, vendor.id, `device_crshadow_${T}`);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);

  const cancelBtn = page
    .getByTestId('my-business-operations')
    .getByRole('button', { name: /rejection reasons|cancel reasons/i })
    .first();
  await expect(cancelBtn).toBeVisible({ timeout: 8000 });
  if ((await cancelBtn.getAttribute('aria-expanded')) !== 'true') await cancelBtn.click();

  // Settings must show the authoritative category-level values (what the
  // cancel flow actually resolves), not the account columns.
  const reasonInputs = page.getByTestId('my-business-operations').locator('input[maxlength="60"]');
  await expect(reasonInputs.first()).toHaveValue('Category stale reason', { timeout: 8000 });
  await expect(reasonInputs.nth(1)).toHaveValue('Category stale second');

  await reasonInputs.first().fill('Fresh edited reason');
  await page.getByRole('button', { name: /save reasons/i }).click();

  // Save must land in the category-level table…
  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('vendor_category_cancel_reasons')
          .select('reason_text')
          .eq('vendor_id', vendor.id)
          .eq('category_id', help.id)
          .eq('position', 1)
          .maybeSingle();
        return data?.reason_text ?? null;
      },
      { timeout: 8000 },
    )
    .toBe('Fresh edited reason');

  // …and leave the legacy account columns untouched.
  const { data: acct } = await supabaseAdmin
    .from('vendors')
    .select('cancel_reason_1')
    .eq('id', vendor.id)
    .single();
  expect(acct?.cancel_reason_1).toBe('Account reason one');

  // The cancellation resolver now yields the fresh edit for this category.
  const { data: catRows } = await supabaseAdmin
    .from('vendor_category_cancel_reasons')
    .select('reason_text, position')
    .eq('vendor_id', vendor.id)
    .eq('category_id', help.id)
    .order('position');
  const reasonsMap = new Map([[help.id, (catRows ?? []).map((r) => r.reason_text)]]);
  expect(
    resolveCancelReasonsForCategory(help.id, reasonsMap, ['Account reason one', 'Account reason two']),
  ).toEqual(['Fresh edited reason', 'Category stale second']);

  // End-to-end: the vendor cancel sheet offers the fresh reason and stores it.
  const customerPhone = nextPhone('88071');
  await supabaseAdmin.from('users').insert({ phone: customerPhone });
  const msg = `CR-SHADOW-01 order ${T}`;
  const { data: order, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      device_id: `device_crshadow_cust_${T}`,
      message: msg,
      status: 'sent',
      category_id: help.id,
    })
    .select('id')
    .single();
  expect(reqErr, reqErr?.message).toBeNull();

  await page.goto(`${APP_URL}/vendor`);
  const card = page.getByTestId('incoming-order-card').filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByRole('button', { name: 'Cancel Order' }).click();

  await expect(page.getByRole('button', { name: 'Fresh edited reason' })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByRole('button', { name: 'Category stale reason' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account reason one' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Fresh edited reason' }).click();
  await page.getByRole('button', { name: 'Confirm Cancel' }).click();

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('requests')
          .select('status, cancel_reason')
          .eq('id', order!.id)
          .single();
        return `${data?.status}|${data?.cancel_reason}`;
      },
      { timeout: 10000 },
    )
    .toBe('cancelled|Fresh edited reason');
});

test('HV-FALLBACK-01 — hidden vendor with no stored phone is NOT logged out; recovers via find-account', async ({
  page,
}) => {
  const help = await getActiveCategoryByServiceMode('help');
  const vendor = await seedVendor({
    shopName: `!HV-HIDDEN-${T}`,
    category: help,
    discoverable: false,
    extra: { is_active: false },
  });

  // Legacy state: vendor_id present, phone missing — no Supabase session.
  await page.goto(APP_URL);
  await page.evaluate((vendorId) => {
    localStorage.clear();
    localStorage.setItem('aaspaas:vendor_id', vendorId);
    localStorage.setItem('aaspaas:role', 'vendor');
    localStorage.setItem('aaspaas:welcomed', 'true');
    localStorage.setItem('aaspaas:vendor_onboarded', 'true');
    localStorage.setItem('aaspaas:device_id', `device_hv_${Date.now()}`);
  }, vendor.id);

  await page.goto(`${APP_URL}/vendor`);

  // Recovery form instead of a silent logout.
  await expect(page.getByText('Find your vendor account')).toBeVisible({ timeout: 20000 });

  // The stored vendor_id must survive (previously it was removed here).
  const storedId = await page.evaluate(() => localStorage.getItem('aaspaas:vendor_id'));
  expect(storedId).toBe(vendor.id);

  // Entering the phone restores the account (hidden vendors included).
  await page.getByPlaceholder('98765 43210').fill(vendor.phone);
  await prepareAndCompleteOtp(page, vendor.phone, () =>
    page.getByRole('button', { name: /find my account/i }).click(),
  );

  await expect(page.getByTestId('vendor-status-badge')).toBeVisible({ timeout: 20000 });
  const storedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(storedPhone).toBe(vendor.phone);
});

test('HV-FALLBACK-02 — discoverable vendor with no stored phone self-heals via get_vendor_own', async ({
  page,
}) => {
  const help = await getActiveCategoryByServiceMode('help');
  const vendor = await seedVendor({
    shopName: `!HV-VISIBLE-${T}`,
    category: help,
    discoverable: true,
  });

  await page.goto(APP_URL);
  await page.evaluate((vendorId) => {
    localStorage.clear();
    localStorage.setItem('aaspaas:vendor_id', vendorId);
    localStorage.setItem('aaspaas:role', 'vendor');
    localStorage.setItem('aaspaas:welcomed', 'true');
    localStorage.setItem('aaspaas:vendor_onboarded', 'true');
    localStorage.setItem('aaspaas:device_id', `device_hv2_${Date.now()}`);
  }, vendor.id);

  await prepareUiOtpSend('hv-fallback-02');
  await page.goto(`${APP_URL}/vendor`);

  // Returning-vendor OTP overlay (session phone does not match). Complete it
  // before asserting on the dashboard, same as completeOtpIfVisible elsewhere.
  await expect(page.getByTestId('vendor-returning-otp')).toBeVisible({ timeout: 20000 });
  await completeOtpIfVisible(page, vendor.phone);
  await expect(page.getByTestId('vendor-returning-otp')).toHaveCount(0);

  // Dashboard loads; the recovered phone is backfilled.
  await expect(page.getByTestId('vendor-status-badge')).toBeVisible({ timeout: 20000 });
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem('aaspaas:user_phone')), {
      timeout: 8000,
    })
    .toBe(vendor.phone);

  const storedId = await page.evaluate(() => localStorage.getItem('aaspaas:vendor_id'));
  expect(storedId).toBe(vendor.id);
});
