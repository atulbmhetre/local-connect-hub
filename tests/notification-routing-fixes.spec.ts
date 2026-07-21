import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_VENDOR_PHONE,
  TEST_ADMIN_PHONE,
  TEST_SESSION,
} from './helpers/setup';
import { resolveRoutePath } from '../src/lib/notificationNavigation';

let testVendor: { id: string; phone: string };

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', testVendor.phone)
    .like('title', `%NRF-${TEST_SESSION}%`);
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .like('title', `%NRF-${TEST_SESSION}%`);
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', TEST_ADMIN_PHONE)
    .like('title', `%NRF-${TEST_SESSION}%`);
  await cleanupTestData();
});

function marker(suffix: string): string {
  return `NRF-${TEST_SESSION}-${suffix}`;
}

async function seedRequest(vendorId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: TEST_CUSTOMER_PHONE,
      message: `NRF order ${TEST_SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

test('NRF-01: category_approved notify produces non-null settings route (not Home)', async () => {
  const m = marker('cat-approved');
  const { data: cat, error: catErr } = await supabaseAdmin
    .from('categories')
    .insert({
      label: `NRF Cat ${TEST_SESSION}`,
      emoji: '🧪',
      service_mode: 'delivery',
      is_active: false,
      pending_review: true,
      suggested_by_vendor_id: testVendor.id,
    })
    .select('id')
    .single();
  expect(catErr).toBeNull();

  try {
    // Explicit route (Settings.notifyCategoryVendor pattern)
    const { error } = await supabase.functions.invoke('notify-vendor', {
      body: {
        record: {
          vendor_id: testVendor.id,
          notification_title: `Category Approved! ${m}`,
          message: `Your category was approved — ${m}`,
          type: 'category_approved',
          route: 'settings',
          route_params: {
            vendor_id: testVendor.id,
            category_id: cat!.id,
          },
        },
      },
    });
    expect(error).toBeNull();

    const { data: row } = await supabaseAdmin
      .from('user_notifications')
      .select('type, route, route_params')
      .eq('user_phone', testVendor.phone)
      .like('title', `%${m}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(row).not.toBeNull();
    expect(row?.type).toBe('category_approved');
    expect(row?.route).toBe('settings');
    expect(row?.route).not.toBeNull();
    expect(resolveRoutePath(row?.route)).toBe('/settings');
    expect(resolveRoutePath(row?.route)).not.toBe('/');
    expect(row?.route_params).toMatchObject({
      vendor_id: testVendor.id,
      category_id: cat!.id,
    });

    // Mapper-only path (no explicit route) — requires deployed buildVendorFcmData branch
    const m2 = marker('cat-mapper');
    const { error: mapperErr } = await supabase.functions.invoke('notify-vendor', {
      body: {
        record: {
          vendor_id: testVendor.id,
          notification_title: `Category Approved! ${m2}`,
          message: `Mapper path — ${m2}`,
          type: 'category_approved',
          category_id: cat!.id,
        },
      },
    });
    expect(mapperErr).toBeNull();
    const { data: mapped } = await supabaseAdmin
      .from('user_notifications')
      .select('type, route, route_params')
      .eq('user_phone', testVendor.phone)
      .like('title', `%${m2}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(mapped?.type).toBe('category_approved');
    expect(mapped?.route).toBe('settings');
    expect(resolveRoutePath(mapped?.route)).toBe('/settings');
  } finally {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', testVendor.phone).like('title', `%NRF-${TEST_SESSION}%`);
    await supabaseAdmin.from('categories').delete().eq('id', cat!.id);
  }
});

test('NRF-02: low-rating review_received is distinct from order_update and routes to Settings', async () => {
  const m = marker('review');
  const requestId = await seedRequest(testVendor.id);

  try {
    const { error: reviewErr } = await supabase.functions.invoke('notify-vendor', {
      body: {
        record: {
          vendor_id: testVendor.id,
          notification_title: `New Review ${m}`,
          message: 'You received a low rating. Check your reviews in Settings.',
          request_id: requestId,
          type: 'review_received',
          route: 'settings',
          route_params: { vendor_id: testVendor.id, open_reviews: '1' },
        },
      },
    });
    expect(reviewErr).toBeNull();

    const { error: doneErr } = await supabase.functions.invoke('notify-vendor', {
      body: {
        record: {
          vendor_id: testVendor.id,
          notification_title: `Customer marked done ${m}`,
          message: 'Order marked fulfilled',
          request_id: requestId,
          type: 'order_update',
          route: 'vendor',
          route_params: { order_id: requestId },
        },
      },
    });
    expect(doneErr).toBeNull();

    const { data: rows } = await supabaseAdmin
      .from('user_notifications')
      .select('type, route, route_params, title')
      .eq('user_phone', testVendor.phone)
      .like('title', `%${m}%`)
      .order('created_at', { ascending: true });

    expect(rows?.length).toBe(2);
    const reviewRow = rows?.find((r) => r.type === 'review_received');
    const orderRow = rows?.find((r) => r.type === 'order_update');
    expect(reviewRow).toBeDefined();
    expect(orderRow).toBeDefined();
    expect(reviewRow?.route).toBe('settings');
    expect(resolveRoutePath(reviewRow?.route)).toBe('/settings');
    expect(reviewRow?.route_params).toMatchObject({
      vendor_id: testVendor.id,
      open_reviews: '1',
    });
    expect(orderRow?.type).toBe('order_update');
    expect(orderRow?.type).not.toBe(reviewRow?.type);
  } finally {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', testVendor.phone).like('title', `%${m}%`);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NRF-03: customer payment_confirmed → my-orders; dispute uses payment_disputed', async () => {
  const m = marker('pay');
  const requestId = await seedRequest(testVendor.id);

  try {
    const { error: confirmErr } = await supabase.functions.invoke('notify-user', {
      body: {
        user_phone: TEST_CUSTOMER_PHONE,
        title: `Payment Confirmed ${m}`,
        body: 'Your payment was confirmed',
        type: 'payment_confirmed',
        order_id: requestId,
        route: 'my-orders',
        route_params: { order_id: requestId },
      },
    });
    expect(confirmErr).toBeNull();

    const { error: disputeErr } = await supabase.functions.invoke('notify-user', {
      body: {
        user_phone: TEST_CUSTOMER_PHONE,
        title: `Payment Disputed ${m}`,
        body: 'Vendor disputed your payment',
        type: 'payment_disputed',
        order_id: requestId,
        route: 'my-orders',
        route_params: { order_id: requestId },
      },
    });
    expect(disputeErr).toBeNull();

    const { data: rows } = await supabaseAdmin
      .from('user_notifications')
      .select('type, route, route_params, title')
      .eq('user_phone', TEST_CUSTOMER_PHONE)
      .like('title', `%${m}%`)
      .order('created_at', { ascending: true });

    expect(rows?.length).toBe(2);
    const confirmed = rows?.find((r) => r.type === 'payment_confirmed');
    const disputed = rows?.find((r) => r.type === 'payment_disputed');
    expect(confirmed).toBeDefined();
    expect(disputed).toBeDefined();
    expect(confirmed?.route).toBe('my-orders');
    expect(resolveRoutePath(confirmed?.route)).toBe('/my-orders');
    expect(confirmed?.route_params).toEqual({ order_id: requestId });
    expect(disputed?.type).toBe('payment_disputed');
    expect(disputed?.type).not.toBe('payment_confirmed');
    expect(disputed?.route).toBe('my-orders');
  } finally {
    await supabaseAdmin
      .from('user_notifications')
      .delete()
      .eq('user_phone', TEST_CUSTOMER_PHONE)
      .like('title', `%${m}%`);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NRF-04: admin new_vendor routes to settings (not /vendor)', async () => {
  const m = marker('new-vendor');
  const vendorId = testVendor.id;

  try {
    const { error } = await supabase.functions.invoke('notify-admin', {
      body: {
        title: `New vendor registered ${m}`,
        body: `Shop — delivery`,
        type: 'new_vendor',
        route: 'settings',
        route_params: { vendor_id: vendorId },
      },
    });
    expect(error).toBeNull();

    const { data: row } = await supabaseAdmin
      .from('user_notifications')
      .select('type, route, route_params')
      .eq('user_phone', TEST_ADMIN_PHONE)
      .like('title', `%${m}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(row).not.toBeNull();
    expect(row?.type).toBe('new_vendor');
    expect(row?.route).toBe('settings');
    expect(resolveRoutePath(row?.route)).toBe('/settings');
    expect(resolveRoutePath(row?.route)).not.toBe('/vendor');
    expect(row?.route_params).toEqual({ vendor_id: vendorId });
  } finally {
    await supabaseAdmin
      .from('user_notifications')
      .delete()
      .eq('user_phone', TEST_ADMIN_PHONE)
      .like('title', `%${m}%`);
  }
});
