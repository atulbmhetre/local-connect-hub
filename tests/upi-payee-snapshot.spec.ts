/**
 * UPI payee snapshots on requests + vendor_categories UPI/base_type columns.
 * Phase 4: _stamp_request_upi_payee / snapshot_intended_upi_payee read vendor_categories.
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const CUSTOMER_PHONE = `8817${String(T).slice(-6)}`;
const DEVICE_ID = `device_upi_snap_${TEST_SESSION}`;
const UTR = '123456789012';
const ORIGINAL_UPI = `snap-orig-${T}@upi`;
const SHEET_UPI = `snap-sheet-${T}@upi`;
const CLAIM_UPI = `snap-claim-${T}@upi`;

const SNAPSHOT_COLS =
  'intended_upi_id, intended_upi_qr_url, intended_upi_payee_id, claimed_upi_id, claimed_upi_qr_url, claimed_upi_payee_id';

let vendor: Awaited<ReturnType<typeof createTestVendor>>;

test.beforeAll(async () => {
  vendor = await createTestVendor({
    upi_id: ORIGINAL_UPI,
    shop_name: `!UPI-SNAP-${T}`,
  });
  await supabaseAdmin
    .from('vendors')
    .update({
      upi_qr_url: `https://example.com/qr/${T}.png`,
      upi_qr_payee_id: ORIGINAL_UPI,
    })
    .eq('id', vendor.id);
  await createTestCustomer(CUSTOMER_PHONE);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData(CUSTOMER_PHONE);
});

async function vendorCategoryId(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id')
    .eq('vendor_id', vendor.id)
    .limit(1)
    .single();
  if (error || !data?.category_id) throw error ?? new Error('missing vendor_categories row');
  return data.category_id as string;
}

async function setBusinessUpi(upiId: string, qrUrl: string | null = `https://example.com/qr/${T}.png`) {
  const { error } = await supabaseAdmin
    .from('vendor_categories')
    .update({
      upi_id: upiId,
      upi_qr_url: qrUrl,
      upi_qr_payee_id: upiId,
    })
    .eq('vendor_id', vendor.id);
  if (error) throw error;
}

async function seedRequest(message: string, categoryId: string | null = null) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'accepted',
      payment_status: 'unpaid',
      category_id: categoryId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function insertBill(requestId: string, paymentMode: 'cash' | 'upi' | 'khata') {
  const { data, error } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendor.id,
    p_customer_phone: CUSTOMER_PHONE,
    p_total: 175,
    p_payment_mode: paymentMode,
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'Snap item', quantity: 1, unit_price: 175, unit: null }],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  return data as string;
}

async function loadSnapshots(requestId: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .select(SNAPSHOT_COLS)
    .eq('id', requestId)
    .single();
  if (error) throw error;
  return data;
}

test('UPI-SNAP-01: vendor_categories exposes UPI + base_type columns', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendor_categories')
    .select('upi_id, upi_qr_url, upi_qr_payee_id, base_type')
    .eq('vendor_id', vendor.id)
    .limit(1)
    .maybeSingle();
  expect(error).toBeNull();
  expect(data).toBeTruthy();
  expect(data).toHaveProperty('upi_id');
  expect(data).toHaveProperty('upi_qr_url');
  expect(data).toHaveProperty('upi_qr_payee_id');
  expect(data).toHaveProperty('base_type');
});

test('UPI-SNAP-02: vendor_categories.base_type CHECK matches vendors (shop|home|none)', async () => {
  const { data: row } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendor.id)
    .limit(1)
    .single();
  expect(row?.id).toBeTruthy();

  const { error: bad } = await supabaseAdmin
    .from('vendor_categories')
    .update({ base_type: 'visiting' })
    .eq('id', row!.id);
  expect(bad).not.toBeNull();

  const { error: ok } = await supabaseAdmin
    .from('vendor_categories')
    .update({ base_type: 'shop' })
    .eq('id', row!.id);
  expect(ok).toBeNull();

  await supabaseAdmin.from('vendor_categories').update({ base_type: null }).eq('id', row!.id);
});

test('UPI-SNAP-03: cash and khata bills leave both snapshot sets null', async () => {
  const cashId = await seedRequest(`UPI-SNAP-03 cash ${T}`);
  await insertBill(cashId, 'cash');
  const cashSnap = await loadSnapshots(cashId);
  expect(cashSnap.intended_upi_id).toBeNull();
  expect(cashSnap.intended_upi_qr_url).toBeNull();
  expect(cashSnap.intended_upi_payee_id).toBeNull();
  expect(cashSnap.claimed_upi_id).toBeNull();
  expect(cashSnap.claimed_upi_qr_url).toBeNull();
  expect(cashSnap.claimed_upi_payee_id).toBeNull();

  const khataId = await seedRequest(`UPI-SNAP-03 khata ${T}`);
  await insertBill(khataId, 'khata');
  const khataSnap = await loadSnapshots(khataId);
  expect(khataSnap.intended_upi_id).toBeNull();
  expect(khataSnap.claimed_upi_id).toBeNull();

  const { error: snapCashErr } = await supabase.rpc('snapshot_intended_upi_payee', {
    p_request_id: cashId,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(snapCashErr).toBeNull();
  const cashAfterSheet = await loadSnapshots(cashId);
  expect(cashAfterSheet.intended_upi_id).toBeNull();
});

test('UPI-SNAP-04: UPI bill stamps intended from vendor_categories; sheet refresh; claim stamps claimed', async () => {
  const categoryId = await vendorCategoryId();
  await supabaseAdmin
    .from('vendors')
    .update({
      upi_id: 'account-ignored@upi',
      upi_qr_url: 'https://example.com/account-qr.png',
      upi_qr_payee_id: 'account-ignored@upi',
    })
    .eq('id', vendor.id);
  await setBusinessUpi(ORIGINAL_UPI);

  const requestId = await seedRequest(`UPI-SNAP-04 ${T}`, categoryId);
  await insertBill(requestId, 'upi');

  const afterBill = await loadSnapshots(requestId);
  expect(afterBill.intended_upi_id).toBe(ORIGINAL_UPI);
  expect(afterBill.intended_upi_qr_url).toBe(`https://example.com/qr/${T}.png`);
  expect(afterBill.intended_upi_payee_id).toBe(ORIGINAL_UPI);
  expect(afterBill.claimed_upi_id).toBeNull();
  expect(afterBill.claimed_upi_qr_url).toBeNull();
  expect(afterBill.claimed_upi_payee_id).toBeNull();

  await setBusinessUpi(SHEET_UPI);

  const { error: sheetErr } = await supabase.rpc('snapshot_intended_upi_payee', {
    p_request_id: requestId,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(sheetErr).toBeNull();

  const afterSheet = await loadSnapshots(requestId);
  expect(afterSheet.intended_upi_id).toBe(SHEET_UPI);
  expect(afterSheet.intended_upi_payee_id).toBe(SHEET_UPI);
  expect(afterSheet.claimed_upi_id).toBeNull();

  await setBusinessUpi(CLAIM_UPI);

  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(claimErr).toBeNull();

  const afterClaim = await loadSnapshots(requestId);
  expect(afterClaim.intended_upi_id).toBe(SHEET_UPI);
  expect(afterClaim.claimed_upi_id).toBe(CLAIM_UPI);
  expect(afterClaim.claimed_upi_payee_id).toBe(CLAIM_UPI);
  expect(afterClaim.claimed_upi_qr_url).toBe(`https://example.com/qr/${T}.png`);

  await setBusinessUpi('too-late@upi');
  const { error: postClaimSheetErr } = await supabase.rpc('snapshot_intended_upi_payee', {
    p_request_id: requestId,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(postClaimSheetErr).toBeNull();
  const afterPostClaim = await loadSnapshots(requestId);
  expect(afterPostClaim.intended_upi_id).toBe(SHEET_UPI);
  expect(afterPostClaim.claimed_upi_id).toBe(CLAIM_UPI);
});

test('UPI-SNAP-05: null category_id → null payee snapshot even if vendors.upi_id is set', async () => {
  await supabaseAdmin
    .from('vendors')
    .update({ upi_id: ORIGINAL_UPI, upi_qr_payee_id: ORIGINAL_UPI })
    .eq('id', vendor.id);
  await setBusinessUpi(ORIGINAL_UPI);

  const requestId = await seedRequest(`UPI-SNAP-05 ${T}`, null);
  await insertBill(requestId, 'upi');
  const snap = await loadSnapshots(requestId);
  expect(snap.intended_upi_id).toBeNull();
  expect(snap.intended_upi_qr_url).toBeNull();
  expect(snap.intended_upi_payee_id).toBeNull();
});
