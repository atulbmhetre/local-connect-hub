import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  postDeleteAccount,
  invokeAnonymiseDeletedAccounts,
  uniqueTestPhone,
  cleanupSession38Data,
  createModeVendor,
} from './helpers/session38';
import { TEST_SESSION, cleanupTestVendors } from './helpers/setup';

const CUSTOMER_PHONE = uniqueTestPhone('88006');
const VENDOR_PHONE = uniqueTestPhone('99006');
const UNKNOWN_PHONE = uniqueTestPhone('88007');
const DEVICE_ID = `device_del_${TEST_SESSION}`;

test.afterEach(async () => {
  await cleanupTestVendors();
  await cleanupSession38Data([CUSTOMER_PHONE, VENDOR_PHONE, UNKNOWN_PHONE]);
});

async function seedCustomerWithData() {
  await supabaseAdmin.from('users').insert({
    phone: CUSTOMER_PHONE,
    total_orders: 1,
    deletion_requested_at: null,
  });
  await supabaseAdmin.from('user_devices').insert({
    user_phone: CUSTOMER_PHONE,
    device_id: DEVICE_ID,
    fcm_token: `fcm_${CUSTOMER_PHONE}`,
  });
  await supabaseAdmin.from('user_addresses').insert({
    user_phone: CUSTOMER_PHONE,
    device_id: DEVICE_ID,
    label: 'Home',
    address_text: '123 Delete Test Lane',
    is_default: true,
  });
  const vendor = await createModeVendor('delivery', uniqueTestPhone('99007'));
  await supabaseAdmin.from('requests').insert({
    vendor_id: vendor.id,
    device_id: DEVICE_ID,
    user_phone: CUSTOMER_PHONE,
    message: 'Delete me',
    status: 'sent',
  });
  return vendor.id;
}

test('DEL-01: customer deletion anonymises users.phone to deleted_*', async () => {
  await seedCustomerWithData();

  const { status, body } = await postDeleteAccount({
    phone: CUSTOMER_PHONE,
    type: 'customer',
  });

  expect(status).toBe(200);
  expect(body.ok).toBe(true);

  const { data: original } = await supabaseAdmin
    .from('users')
    .select('phone')
    .eq('phone', CUSTOMER_PHONE)
    .maybeSingle();
  expect(original).toBeNull();

  const { data: anonymised } = await supabaseAdmin
    .from('users')
    .select('phone, deletion_requested_at')
    .like('phone', 'deleted_%')
    .limit(1)
    .maybeSingle();

  expect(anonymised?.phone).toMatch(/^deleted_/);
  expect(anonymised?.deletion_requested_at).not.toBeNull();
});

test('DEL-02: customer deletion removes user_devices rows', async () => {
  await seedCustomerWithData();

  await postDeleteAccount({ phone: CUSTOMER_PHONE, type: 'customer' });

  const { data } = await supabaseAdmin
    .from('user_devices')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE);
  expect(data).toEqual([]);
});

test('DEL-03: customer deletion removes user_addresses rows', async () => {
  await seedCustomerWithData();

  await postDeleteAccount({ phone: CUSTOMER_PHONE, type: 'customer' });

  const { data } = await supabaseAdmin
    .from('user_addresses')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE);
  expect(data).toEqual([]);
});

test('DEL-04: customer deletion anonymises requests.user_phone', async () => {
  await seedCustomerWithData();

  await postDeleteAccount({ phone: CUSTOMER_PHONE, type: 'customer' });

  const { data: originalRequests } = await supabaseAdmin
    .from('requests')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE);
  expect(originalRequests).toEqual([]);

  const { data: anonymisedRequests } = await supabaseAdmin
    .from('requests')
    .select('user_phone, message')
    .like('user_phone', 'deleted_%');
  expect(anonymisedRequests?.length).toBeGreaterThan(0);
  expect(anonymisedRequests![0].message).toBe('Order deleted');
});

test('DEL-05: vendor deletion schedules but does not anonymise immediately', async () => {
  await supabaseAdmin.from('users').insert({ phone: VENDOR_PHONE, total_orders: 0 });
  await createModeVendor('delivery', VENDOR_PHONE);

  const { status, body } = await postDeleteAccount({
    phone: VENDOR_PHONE,
    type: 'vendor',
  });

  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.message).toBe('Deletion scheduled');

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('phone, deletion_requested_at')
    .eq('phone', VENDOR_PHONE)
    .single();
  expect(vendor.phone).toBe(VENDOR_PHONE);
  expect(vendor.deletion_requested_at).not.toBeNull();

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('deletion_requested_at')
    .eq('phone', VENDOR_PHONE)
    .single();
  expect(user.deletion_requested_at).not.toBeNull();
});

test('DEL-06: cancel clears deletion_requested_at on users and vendors', async () => {
  await supabaseAdmin.from('users').insert({
    phone: VENDOR_PHONE,
    deletion_requested_at: new Date().toISOString(),
  });
  await supabaseAdmin.from('vendors').insert({
    name: 'Cancel Vendor',
    shop_name: 'Cancel Shop',
    phone: VENDOR_PHONE,
    category: 'Grocery',
    service_mode: 'delivery',
    is_active: true,
    vendor_note: `test_session:${TEST_SESSION}`,
    deletion_requested_at: new Date().toISOString(),
  });

  const { status, body } = await postDeleteAccount({
    phone: VENDOR_PHONE,
    action: 'cancel',
  });

  expect(status).toBe(200);
  expect(body.ok).toBe(true);

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('deletion_requested_at')
    .eq('phone', VENDOR_PHONE)
    .single();
  expect(user.deletion_requested_at).toBeNull();

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('phone', VENDOR_PHONE)
    .single();
  expect(vendor.deletion_requested_at).toBeNull();
});

test('DEL-07: unknown customer phone returns 404 account_not_found', async () => {
  const { status, body } = await postDeleteAccount({
    phone: UNKNOWN_PHONE,
    type: 'customer',
  });

  expect(status).toBe(404);
  expect(body.error).toBe('account_not_found');
});

test('DEL-08: anonymise_deleted_accounts is idempotent for already-anonymised phone', async () => {
  const vendor = await createModeVendor('delivery', uniqueTestPhone('99008'));
  await supabaseAdmin.from('users').insert({
    phone: CUSTOMER_PHONE,
    deletion_requested_at: new Date().toISOString(),
  });
  const { data: request } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      device_id: DEVICE_ID,
      user_phone: CUSTOMER_PHONE,
      message: 'Idempotency test',
      status: 'sent',
    })
    .select('id')
    .single();

  await invokeAnonymiseDeletedAccounts();

  const { data: afterFirst } = await supabaseAdmin
    .from('requests')
    .select('user_phone')
    .eq('id', request!.id)
    .single();
  const anonPhone = afterFirst!.user_phone as string;
  expect(anonPhone).toMatch(/^deleted_/);

  await invokeAnonymiseDeletedAccounts();

  const { data: afterSecond } = await supabaseAdmin
    .from('requests')
    .select('user_phone')
    .eq('id', request!.id)
    .single();
  expect(afterSecond!.user_phone).toBe(anonPhone);
});

test('DEL-09: vendor with deletion_requested_at = now() is not anonymised immediately', async () => {
  await supabaseAdmin.from('vendors').insert({
    name: 'Grace Vendor',
    shop_name: 'Grace Shop',
    phone: VENDOR_PHONE,
    category: 'Grocery',
    service_mode: 'delivery',
    is_active: true,
    vendor_note: `test_session:${TEST_SESSION}`,
    deletion_requested_at: new Date().toISOString(),
  });

  await invokeAnonymiseDeletedAccounts();

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('phone, shop_name')
    .eq('phone', VENDOR_PHONE)
    .maybeSingle();

  expect(vendor?.phone).toBe(VENDOR_PHONE);
  expect(vendor?.shop_name).toBe('Grace Shop');
});

test('DEL-10: vendor with deletion_requested_at 31 days ago is anonymised', async () => {
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from('users').insert({
    phone: VENDOR_PHONE,
    deletion_requested_at: thirtyOneDaysAgo,
  });
  await supabaseAdmin.from('vendors').insert({
    name: 'Old Delete Vendor',
    shop_name: 'Old Shop',
    phone: VENDOR_PHONE,
    category: 'Grocery',
    service_mode: 'delivery',
    is_active: true,
    vendor_note: `test_session:${TEST_SESSION}`,
    deletion_requested_at: thirtyOneDaysAgo,
  });

  await invokeAnonymiseDeletedAccounts();

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('phone, shop_name, is_banned')
    .eq('phone', VENDOR_PHONE)
    .maybeSingle();
  expect(vendor).toBeNull();

  const { data: anonymised } = await supabaseAdmin
    .from('vendors')
    .select('phone, shop_name, is_banned')
    .like('phone', 'deleted_%')
    .eq('shop_name', 'Deleted Shop')
    .limit(1)
    .maybeSingle();

  expect(anonymised?.phone).toMatch(/^deleted_/);
  expect(anonymised?.is_banned).toBe(true);
});
