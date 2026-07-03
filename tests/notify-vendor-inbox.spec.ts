import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
} from './helpers/setup';

let testVendor: { id: string; phone: string };

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', testVendor.phone);
  await cleanupTestData();
});

function testMarker(suffix: string): string {
  return `NVI-${TEST_SESSION}-${suffix}`;
}

async function seedRequest(vendorId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: TEST_CUSTOMER_PHONE,
      message: `Notify vendor inbox ${TEST_SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function invokeNotifyVendor(record: Record<string, unknown>) {
  return supabase.functions.invoke('notify-vendor', { body: { record } });
}

async function cleanupNotificationsForMarker(vendorPhone: string, marker: string) {
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', vendorPhone)
    .like('title', `%${marker}%`);
}

async function fetchNotificationByMarker(vendorPhone: string, marker: string) {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .select(
      'user_phone, title, body, type, route, route_params, read_at, is_read, created_at',
    )
    .eq('user_phone', vendorPhone)
    .like('title', `%${marker}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

test('NVI-01 — inbox row created with correct fields', async () => {
  const marker = testMarker('01');
  const requestId = await seedRequest(testVendor.id);
  const title = `Payment claimed ${marker}`;
  const body = `Customer claims payment — ${marker}`;

  try {
    const { data, error } = await invokeNotifyVendor({
      vendor_id: testVendor.id,
      notification_title: title,
      message: body,
      type: 'payment_claimed',
      request_id: requestId,
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const row = await fetchNotificationByMarker(testVendor.phone, marker);
    expect(row).not.toBeNull();
    expect(row?.user_phone).toBe(testVendor.phone);
    expect(row?.title).toBe(title);
    expect(row?.body).toBe(body);
    expect(row?.type).toBe('payment_claimed');
    expect(row?.read_at).toBeNull();
    expect(row?.is_read).toBe(false);
  } finally {
    await cleanupNotificationsForMarker(testVendor.phone, marker);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NVI-02 — route/route_params correctly resolved for payment_claimed', async () => {
  const marker = testMarker('02');
  const requestId = await seedRequest(testVendor.id);
  const title = `Payment claimed route ${marker}`;
  const body = `UTR submitted — ${marker}`;

  try {
    const { data, error } = await invokeNotifyVendor({
      vendor_id: testVendor.id,
      notification_title: title,
      message: body,
      type: 'payment_claimed',
      request_id: requestId,
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const row = await fetchNotificationByMarker(testVendor.phone, marker);
    expect(row).not.toBeNull();
    expect(row?.route).toBe('vendor');
    expect(row?.route_params).toEqual({ order_id: requestId });
  } finally {
    await cleanupNotificationsForMarker(testVendor.phone, marker);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NVI-03 — works even when vendor has no FCM token', async () => {
  const marker = testMarker('03');
  const requestId = await seedRequest(testVendor.id);
  const title = `Payment claimed no-fcm ${marker}`;
  const body = `No token path — ${marker}`;

  const { data: vendorBefore } = await supabaseAdmin
    .from('vendors')
    .select('fcm_token')
    .eq('id', testVendor.id)
    .single();
  const previousToken = vendorBefore?.fcm_token ?? null;

  try {
    const { error: clearTokenError } = await supabaseAdmin
      .from('vendors')
      .update({ fcm_token: null })
      .eq('id', testVendor.id);
    expect(clearTokenError).toBeNull();

    const { data, error } = await invokeNotifyVendor({
      vendor_id: testVendor.id,
      notification_title: title,
      message: body,
      type: 'payment_claimed',
      request_id: requestId,
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const row = await fetchNotificationByMarker(testVendor.phone, marker);
    expect(row).not.toBeNull();
    expect(row?.title).toBe(title);
    expect(row?.body).toBe(body);
    expect(row?.type).toBe('payment_claimed');
  } finally {
    await supabaseAdmin
      .from('vendors')
      .update({ fcm_token: previousToken })
      .eq('id', testVendor.id);
    await cleanupNotificationsForMarker(testVendor.phone, marker);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NVI-04 — explicit route/route_params on the record are respected, not overridden', async () => {
  const marker = testMarker('04');
  const requestId = await seedRequest(testVendor.id);
  const title = `Custom route ${marker}`;
  const body = `Explicit route params — ${marker}`;

  try {
    const { data, error } = await invokeNotifyVendor({
      vendor_id: testVendor.id,
      notification_title: title,
      message: body,
      type: 'payment_claimed',
      request_id: requestId,
      route: 'vendor-custom',
      route_params: { foo: 'bar' },
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const row = await fetchNotificationByMarker(testVendor.phone, marker);
    expect(row).not.toBeNull();
    expect(row?.route).toBe('vendor-custom');
    expect(row?.route_params).toEqual({ foo: 'bar' });
    expect(row?.route_params).not.toEqual({ order_id: requestId });
  } finally {
    await cleanupNotificationsForMarker(testVendor.phone, marker);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});

test('NVI-05 — missing title and body does not create an inbox row', async () => {
  const marker = testMarker('05');
  const requestId = await seedRequest(testVendor.id);

  try {
    const { count: beforeCount } = await supabaseAdmin
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_phone', testVendor.phone)
      .like('title', `%${marker}%`);

    const { data, error } = await invokeNotifyVendor({
      vendor_id: testVendor.id,
      notification_title: '   ',
      message: '',
      type: 'payment_claimed',
      request_id: requestId,
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const { count: afterCount } = await supabaseAdmin
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_phone', testVendor.phone)
      .like('title', `%${marker}%`);

    expect(afterCount ?? 0).toBe(beforeCount ?? 0);

    const row = await fetchNotificationByMarker(testVendor.phone, marker);
    expect(row).toBeNull();
  } finally {
    await cleanupNotificationsForMarker(testVendor.phone, marker);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
});
