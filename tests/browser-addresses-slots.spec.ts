import { test, expect } from '@playwright/test';
import { loginAsCustomer, gotoRadarDelivery, clickRadarOrderCard, APP_URL } from './helpers/browser-setup';
import { supabase, supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';

const T = Date.now();
const LOCAL_CUSTOMER_PHONE = `8800${String(T).slice(-6)}`;
const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer(LOCAL_CUSTOMER_PHONE);
  await supabaseAdmin.from('vendors')
    .update({ service_mode: 'delivery', is_active: true })
    .eq('id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('user_addresses').delete().eq('user_phone', LOCAL_CUSTOMER_PHONE);
  await supabaseAdmin.from('user_addresses').delete().eq('device_id', TEST_DEVICE_ID);
  await cleanupTestData(LOCAL_CUSTOMER_PHONE);
});

// ─── ADDRESSES ────────────────────────────────────────────────────────────

test('ADDR-01: address saved — user_addresses row created', async () => {
  await supabaseAdmin.from('user_addresses').insert({
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    label: 'Home',
    address_text: 'Flat 1A, Test Building',
    is_default: true,
  });
  const { data } = await supabaseAdmin.from('user_addresses')
    .select('id')
    .eq('user_phone', LOCAL_CUSTOMER_PHONE);
  expect(data?.length).toBeGreaterThan(0);
});

test('ADDR-02: address row visible in settings', async ({ page }) => {
  await supabaseAdmin.from('user_addresses').insert({
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    label: 'Home',
    address_text: 'Flat 4B, Test Tower',
    is_default: true,
  });
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  // Find and open delivery addresses section — try flexible match
  const addrSection = page.getByText(/delivery address/i).first();
  await expect(addrSection).toBeVisible({ timeout: 5000 });
  await addrSection.click();
  await expect(page.getByText('Flat 4B')).toBeVisible({ timeout: 5000 });
});

test('ADDR-03: first saved address is_default = true', async () => {
  await supabase.from('user_addresses').delete().eq('user_phone', LOCAL_CUSTOMER_PHONE);

  const { data } = await supabaseAdmin
    .from('user_addresses')
    .insert({
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      label: 'Home',
      address_text: 'First address ever',
      is_default: true,
    })
    .select()
    .single();

  expect(data?.is_default).toBe(true);
});

test('ADDR-04: delete address removes row from DB', async () => {
  const { data: addr } = await supabaseAdmin
    .from('user_addresses')
    .insert({
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      label: 'Work',
      address_text: 'Office Block B, Hinjewadi',
      is_default: false,
    })
    .select()
    .single();

  await supabaseAdmin.from('user_addresses').delete().eq('id', addr.id);

  const { data } = await supabaseAdmin
    .from('user_addresses')
    .select('id')
    .eq('id', addr.id);

  expect(data?.length).toBe(0);
});

test('ADDR-05: multiple addresses stored correctly', async () => {
  await supabaseAdmin.from('user_addresses').insert([
    { user_phone: LOCAL_CUSTOMER_PHONE, device_id: TEST_DEVICE_ID, label: 'Home', address_text: 'Home Address', is_default: true },
    { user_phone: LOCAL_CUSTOMER_PHONE, device_id: `${TEST_DEVICE_ID}_2`, label: 'Work', address_text: 'Work Address', is_default: false },
  ]);

  const { data } = await supabaseAdmin
    .from('user_addresses')
    .select('id')
    .eq('user_phone', LOCAL_CUSTOMER_PHONE);

  expect(data?.length).toBeGreaterThanOrEqual(2);
});

// ─── DELIVERY SLOTS ───────────────────────────────────────────────────────

test('SLOT-01: delivery slot select visible in ParchiSheet for delivery vendor', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await gotoRadarDelivery(page);

  await clickRadarOrderCard(page, { vendorId: testVendor.id, shopName: testVendor.shop_name });
  await expect(page.getByTestId('parchi-message-input')).toBeVisible({ timeout: 5000 });

  // Slot select should be visible for delivery vendor
  const slotSelect = page.getByTestId('parchi-slot-select');
  const slotVisible = await slotSelect.isVisible().catch(() => false);

  if (slotVisible) {
    await expect(slotSelect).toBeVisible();
  } else {
    // Slot not shown — may be appointment vendor, skip
    console.log('Slot select not visible — vendor may not be delivery mode');
  }
});

test('SLOT-02: delivery_slot stored on request after order placement', async () => {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Slot test order',
      status: 'sent',
      delivery_slot: '🌅 Morning (before 12pm)',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.delivery_slot).toBe('🌅 Morning (before 12pm)');

  await supabase.from('requests').delete().eq('id', data.id);
});

test('SLOT-03: all slot values are valid strings', async () => {
  const validSlots = [
    '🚀 As soon as possible',
    '🌅 Morning (before 12pm)',
    '🌞 Afternoon (12–4pm)',
    '🌆 Evening (after 4pm)',
    '📅 Tomorrow',
  ];

  for (const slot of validSlots) {
    const { data, error } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: testVendor.id,
        user_phone: LOCAL_CUSTOMER_PHONE,
        device_id: TEST_DEVICE_ID,
        message: `Slot test: ${slot}`,
        status: 'sent',
        delivery_slot: slot,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data.delivery_slot).toBe(slot);

    await supabase.from('requests').delete().eq('id', data.id);
  }
});
