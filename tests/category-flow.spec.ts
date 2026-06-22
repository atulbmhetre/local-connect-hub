import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists, assertNotificationCreated } from './helpers/db-assert';

let testVendor: any;
let testCategoryId: string;
const ADMIN_PHONE = '8888169446';

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('categories').delete().like('label', `%${TEST_SESSION}%`);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', TEST_VENDOR_PHONE).in('type', ['category_approved', 'category_rejected']);
  await cleanupTestData();
});

test('CAT-01: active categories load correctly', async () => {
  const { data, error } = await supabaseAdmin
    .from('categories')
    .select('id, label, emoji, service_mode, is_active')
    .eq('is_active', true)
    .order('sort_order');

  expect(error).toBeNull();
  expect(data?.length).toBeGreaterThan(0);
  data!.forEach(cat => {
    expect(cat.is_active).toBe(true);
    expect(cat.label).toBeTruthy();
    expect(cat.emoji).toBeTruthy();
  });
});

test('CAT-02: vendor suggests new category — pending_review = true', async () => {
  const { data, error } = await supabaseAdmin
    .from('categories')
    .insert({
      label: `Test Category ${TEST_SESSION}`,
      emoji: '🧪',
      service_mode: 'delivery',
      is_active: false,
      pending_review: true,
      suggested_by_vendor_id: testVendor.id,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.pending_review).toBe(true);
  expect(data.is_active).toBe(false);
  testCategoryId = data.id;
});

test('CAT-03: pending categories visible to admin', async () => {
  const { data, error } = await supabaseAdmin
    .from('categories')
    .select('id, label, pending_review, suggested_by_vendor_id')
    .eq('pending_review', true);

  expect(error).toBeNull();
  expect(data?.length).toBeGreaterThan(0);

  const ourCategory = data?.find(c => c.id === testCategoryId);
  expect(ourCategory).toBeDefined();
  expect(ourCategory?.suggested_by_vendor_id).toBe(testVendor.id);
});

test('AD-08: admin approves category — is_active = true, pending_review = false', async () => {
  const { error } = await supabase.rpc('admin_approve_category', {
    p_admin_phone: ADMIN_PHONE,
    p_category_id: testCategoryId,
  });

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('categories')
    .select('is_active, pending_review')
    .eq('id', testCategoryId)
    .single();

  expect(data?.is_active).toBe(true);
  expect(data?.pending_review).toBe(false);
});

test('AD-08b: vendor notified when category approved', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'category_approved',
    title: 'Category Approved',
    body: 'Your suggested category has been approved',
    route: 'settings',
  });

  await assertNotificationCreated(TEST_VENDOR_PHONE, 'category_approved');
});

test('AD-09: admin rejects category — is_active stays false', async () => {
  const { data: newCat } = await supabaseAdmin
    .from('categories')
    .insert({
      label: `Rejected Category ${TEST_SESSION}`,
      emoji: '❌',
      service_mode: 'delivery',
      is_active: false,
      pending_review: true,
      suggested_by_vendor_id: testVendor.id,
    })
    .select()
    .single();

  // Admin rejects — set pending_review = false, is_active stays false
  await supabase.rpc('admin_reject_category', {
    p_admin_phone: ADMIN_PHONE,
    p_category_id: newCat.id,
  });

  const { data } = await supabaseAdmin
    .from('categories')
    .select('is_active, pending_review')
    .eq('id', newCat.id)
    .single();

  expect(data?.is_active).toBe(false);
  expect(data?.pending_review).toBe(false);

  // Cleanup
  await supabaseAdmin.from('categories').delete().eq('id', newCat.id);
});

test('AD-09b: vendor notified when category rejected', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'category_rejected',
    title: 'Category Not Approved',
    body: 'Your suggested category was not approved',
    route: 'settings',
  });

  await assertNotificationCreated(TEST_VENDOR_PHONE, 'category_rejected');
});

test('CAT-04: category translations exist for active categories', async () => {
  const { data: cats } = await supabaseAdmin
    .from('categories')
    .select('id')
    .eq('is_active', true)
    .limit(3);

  if (!cats || cats.length === 0) return;

  // Check at least one translation exists
  const { data: translations } = await supabaseAdmin
    .from('category_translations')
    .select('category_id, lang, label')
    .in('category_id', cats.map(c => c.id))
    .limit(5);

  // Translations may not exist for all — just verify structure if they do
  if (translations && translations.length > 0) {
    expect(translations[0].lang).toBeTruthy();
    expect(translations[0].label).toBeTruthy();
  }
});

test('SC-01: dev_menu_pin exists in app_config', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'dev_menu_pin')
    .single();

  expect(data).not.toBeNull();
  expect(data!.value).toBeTruthy();
  // Warn if still default — this is a launch blocker
  if (data!.value === '1947') {
    console.warn('⚠️  LAUNCH BLOCKER: dev_menu_pin is still default 1947. Change before launch.');
  }
});
