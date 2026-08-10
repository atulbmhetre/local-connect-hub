import { test, expect } from '@playwright/test';
import { loginAsVendor, loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';
import { resolveKhataTxBusinessChip } from '../src/lib/khataDisplay';

/**
 * Khata display traceability — business chip per bill-linked tx; Payment/Refund
 * plain when no request_id. Balance totals must be unchanged.
 */

const T = Date.now();
const VENDOR_PHONE = `99021${String(T).slice(-5)}`;
const CUSTOMER_PHONE = `88010${String(T).slice(-5)}`;
const DEVICE_ID = `kt_device_${T}`;
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdTxIds: string[] = [];

test.afterAll(async () => {
  if (createdTxIds.length) {
    await supabaseAdmin.from('khata_transactions').delete().in('id', createdTxIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', CUSTOMER_PHONE);
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('KHATA-TRACE-01: category chips per business; Payment/Refund plain; balance unchanged', async ({
  page,
}) => {
  test.setTimeout(90000);
  const cobbler = await getActiveCategoryByLabel('Cobbler');
  const carpenter = await getActiveCategoryByLabel('Carpenter');

  const { data: vendor, error: vErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Khata Trace Owner',
      shop_name: `!KT-${T}`,
      phone: VENDOR_PHONE,
      category: cobbler.label,
      service_mode: cobbler.service_mode,
      latitude: 18.52,
      longitude: 73.85,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 15,
      khata_amber_limit: 500,
      khata_red_limit: 1000,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  expect(vErr).toBeNull();
  createdVendorIds.push(vendor!.id);

  await seedVendorCategory(vendor!.id, cobbler, { is_primary: true });
  await seedVendorCategory(vendor!.id, carpenter, { is_primary: false });

  async function seedFulfilledRequest(categoryId: string) {
    const { data: req, error } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: vendor!.id,
        device_id: DEVICE_ID,
        user_phone: CUSTOMER_PHONE,
        message: 'khata job',
        status: 'fulfilled',
        service_mode: 'delivery',
        category_id: categoryId,
        fulfilled_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    createdRequestIds.push(req!.id);
    return req!.id as string;
  }

  const cobblerReq = await seedFulfilledRequest(cobbler.id);
  const carpenterReq = await seedFulfilledRequest(carpenter.id);

  const { data: ledgerBefore, error: lbErr } = await supabaseAdmin
    .from('khata_ledger')
    .upsert(
      {
        vendor_id: vendor!.id,
        user_phone: CUSTOMER_PHONE,
        total_outstanding: 350,
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'vendor_id,user_phone' },
    )
    .select('total_outstanding')
    .single();
  expect(lbErr).toBeNull();
  const outstandingBefore = Number(ledgerBefore!.total_outstanding);

  const inserts = [
    {
      vendor_id: vendor!.id,
      user_phone: CUSTOMER_PHONE,
      amount: 200,
      note: 'Cobbler bill',
      payment_mode: 'khata',
      request_id: cobblerReq,
    },
    {
      vendor_id: vendor!.id,
      user_phone: CUSTOMER_PHONE,
      amount: 150,
      note: 'Carpenter bill',
      payment_mode: 'khata',
      request_id: carpenterReq,
    },
    {
      vendor_id: vendor!.id,
      user_phone: CUSTOMER_PHONE,
      amount: 50,
      note: 'Payment received',
      payment_mode: 'paid',
      request_id: null,
    },
    {
      vendor_id: vendor!.id,
      user_phone: CUSTOMER_PHONE,
      amount: 20,
      note: 'Refund to customer',
      payment_mode: 'khata',
      request_id: null,
    },
  ];

  const { data: txs, error: txErr } = await supabaseAdmin
    .from('khata_transactions')
    .insert(inserts)
    .select('id');
  expect(txErr).toBeNull();
  for (const t of txs ?? []) createdTxIds.push(t.id);

  const { data: myRows, error: myErr } = await supabaseAdmin.rpc('get_my_khata_transactions', {
    p_user_phone: CUSTOMER_PHONE,
    p_vendor_id: vendor!.id,
  });
  expect(myErr).toBeNull();
  const rows = (myRows ?? []) as Array<{
    note: string | null;
    payment_mode: string;
    request_id: string | null;
    category_label: string | null;
    category_emoji: string | null;
    amount: number;
  }>;

  const cobblerTx = rows.find((r) => r.note === 'Cobbler bill');
  const carpenterTx = rows.find((r) => r.note === 'Carpenter bill');
  const paymentTx = rows.find((r) => r.payment_mode === 'paid');
  const refundTx = rows.find((r) => r.note === 'Refund to customer');

  expect(cobblerTx?.category_label).toBe(cobbler.label);
  expect(carpenterTx?.category_label).toBe(carpenter.label);
  expect(paymentTx?.request_id).toBeNull();
  expect(paymentTx?.category_label).toBeNull();
  expect(refundTx?.request_id).toBeNull();
  expect(refundTx?.category_label).toBeNull();

  expect(resolveKhataTxBusinessChip(cobblerTx!).kind).toBe('business');
  expect(
    resolveKhataTxBusinessChip(cobblerTx!).kind === 'business' &&
      resolveKhataTxBusinessChip(cobblerTx!).label,
  ).toBe(cobbler.label);
  expect(
    resolveKhataTxBusinessChip(carpenterTx!).kind === 'business' &&
      resolveKhataTxBusinessChip(carpenterTx!).label,
  ).toBe(carpenter.label);
  expect(resolveKhataTxBusinessChip(paymentTx!).kind).toBe('payment');
  expect(resolveKhataTxBusinessChip(refundTx!).kind).toBe('refund');

  const { data: ledgerAfter } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', vendor!.id)
    .eq('user_phone', CUSTOMER_PHONE)
    .single();
  expect(Number(ledgerAfter!.total_outstanding)).toBe(outstandingBefore);

  // Vendor Ledger UI
  await loginAsVendor(page, VENDOR_PHONE, vendor!.id, DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('ledger-screen')).toHaveAttribute('data-loading', 'false', {
    timeout: 15000,
  });
  await page.getByRole('button', { name: /₹350\.00/ }).click();
  await expect(page.getByTestId('ledger-balance')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Cobbler bill')).toBeVisible({ timeout: 10000 });

  await expect(
    page.locator(
      '[data-testid="khata-tx-source-chip"][data-chip-kind="business"][data-category-label="Cobbler"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="khata-tx-source-chip"][data-chip-kind="business"][data-category-label="Carpenter"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="khata-tx-source-chip"][data-chip-kind="payment"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="khata-tx-source-chip"][data-chip-kind="refund"]'),
  ).toBeVisible();

  // Customer My Khata
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByText(/My Dues|मेरा बकाया|माझी थकबाकी/i).first()).toBeVisible({
    timeout: 15000,
  });
  await page.getByText(`!KT-${T}`).first().click();
  await expect(page.getByText('Cobbler bill')).toBeVisible({ timeout: 10000 });
  await expect(
    page.locator(
      '[data-testid="khata-tx-source-chip"][data-chip-kind="business"][data-category-label="Cobbler"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="khata-tx-source-chip"][data-chip-kind="business"][data-category-label="Carpenter"]',
    ),
  ).toBeVisible();

  console.log('KHATA-TRACE-01 OK', {
    cobbler: cobblerTx?.category_label,
    carpenter: carpenterTx?.category_label,
    outstandingBefore,
    outstandingAfter: ledgerAfter!.total_outstanding,
  });
});
