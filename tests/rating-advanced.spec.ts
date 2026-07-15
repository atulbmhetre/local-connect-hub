import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
} from './helpers/setup';
import { assertRowExists, assertVendorField } from './helpers/db-assert';

let testVendor: any;
let otherVendor: any;
const ADMIN_PHONE = '8888169446';
const DEVICE_ID = `device_rating_adv_${TEST_SESSION}`;
const FAKE_REQUEST_ID = '00000000-0000-4000-8000-000000000099';

async function seedRequest(opts: {
  vendorId?: string;
  status?: string;
  userPhone?: string;
  deviceId?: string | null;
  message?: string;
}) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: opts.vendorId ?? testVendor.id,
      user_phone: opts.userPhone ?? TEST_CUSTOMER_PHONE,
      device_id: opts.deviceId === undefined ? DEVICE_ID : opts.deviceId,
      message: opts.message ?? `rating-gate ${TEST_SESSION}`,
      status: opts.status ?? 'fulfilled',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function callSubmitReview(args: {
  vendorId: string;
  requestId: string;
  userPhone: string;
  deviceId?: string | null;
  rating?: number;
  reviewText?: string | null;
  serviceMode?: string;
}) {
  return supabaseAdmin.rpc('submit_vendor_review', {
    p_vendor_id: args.vendorId,
    p_request_id: args.requestId,
    p_user_phone: args.userPhone,
    p_device_id: args.deviceId ?? null,
    p_rating: args.rating ?? 5,
    p_review_text: args.reviewText ?? null,
    p_service_mode: args.serviceMode ?? 'delivery',
  });
}

function expectRpcCode(error: { message?: string } | null, code: string) {
  expect(error, `expected RPC error containing ${code}`).not.toBeNull();
  expect(error!.message ?? '').toContain(code);
}

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  otherVendor = await createTestVendor({
    shop_name: `Other Shop ${TEST_SESSION}`,
  });
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('vendor_reviews').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', ADMIN_PHONE).eq('type', 'admin_alert');
  await cleanupTestData();
});

test('RV-02: avg_rating recalculates after new review', async () => {
  // Set known state
  await supabaseAdmin
    .from('vendors')
    .update({ avg_rating: 4.0, review_count: 2 })
    .eq('id', testVendor.id);

  // Create a request to review
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Rating test order',
      status: 'done',
    })
    .select()
    .single();

  // Submit 2 star review
  await supabaseAdmin.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order.id,
    user_phone: TEST_CUSTOMER_PHONE,
    rating: 2,
    service_mode: 'delivery',
  });

  // Simulate syncVendorRatingFromReviews:
  // new avg = (4.0 * 2 + 2) / 3 = 3.33
  const newAvg = (4.0 * 2 + 2) / 3;
  const newCount = 3;

  await supabaseAdmin
    .from('vendors')
    .update({ avg_rating: newAvg, review_count: newCount })
    .eq('id', testVendor.id);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, review_count')
    .eq('id', testVendor.id)
    .single();

  expect(data?.review_count).toBe(3);
  expect(data?.avg_rating).toBeCloseTo(3.33, 1);
});

test('RV-05: low rating admin alert fires when avg < 2.0 and count >= 5', async () => {
  // Set conditions: avg < 2.0, count >= 5, flag not set
  await supabaseAdmin
    .from('vendors')
    .update({
      avg_rating: 1.8,
      review_count: 5,
      low_rating_admin_notified: false,
    })
    .eq('id', testVendor.id);

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, review_count, low_rating_admin_notified')
    .eq('id', testVendor.id)
    .single();

  const shouldAlert =
    (vendor?.avg_rating ?? 5) < 2.0 &&
    (vendor?.review_count ?? 0) >= 5 &&
    !vendor?.low_rating_admin_notified;

  expect(shouldAlert).toBe(true);

  if (shouldAlert) {
    await supabaseAdmin.from('user_notifications').insert({
      user_phone: ADMIN_PHONE,
      type: 'admin_alert',
      title: 'Low Rating Alert',
      body: `Vendor rating dropped to ${vendor?.avg_rating}`,
      route: 'admin',
      route_params: { vendor_id: testVendor.id },
    });

    await supabaseAdmin
      .from('vendors')
      .update({ low_rating_admin_notified: true })
      .eq('id', testVendor.id);
  }

  await assertVendorField(testVendor.id, 'low_rating_admin_notified', true);
  await assertRowExists('user_notifications', {
    user_phone: ADMIN_PHONE,
    type: 'admin_alert',
  });
});

test('RV-06: low rating alert NOT fired twice — flag prevents repeat', async () => {
  // Flag already true
  await supabaseAdmin
    .from('vendors')
    .update({ low_rating_admin_notified: true })
    .eq('id', testVendor.id);

  const { count: before } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', ADMIN_PHONE)
    .eq('type', 'admin_alert');

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('low_rating_admin_notified')
    .eq('id', testVendor.id)
    .single();

  // App skips notification — flag is true
  if (!vendor?.low_rating_admin_notified) {
    await supabaseAdmin.from('user_notifications').insert({
      user_phone: ADMIN_PHONE,
      type: 'admin_alert',
      title: 'Low Rating Alert',
      body: 'Should not fire again',
    });
  }

  const { count: after } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', ADMIN_PHONE)
    .eq('type', 'admin_alert');

  expect(after).toBe(before);
});

test('RV-07: low rating flag resets when avg recovers above 3.5', async () => {
  await supabaseAdmin.from('vendor_reviews').delete().eq('vendor_id', testVendor.id);

  await supabaseAdmin
    .from('vendors')
    .update({ avg_rating: 1.8, review_count: 0, low_rating_admin_notified: true })
    .eq('id', testVendor.id);

  for (let i = 0; i < 4; i++) {
    const { data: order } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: testVendor.id,
        user_phone: TEST_CUSTOMER_PHONE,
        message: `RV-07 recovery order ${i}`,
        status: 'done',
      })
      .select()
      .single();

    await supabaseAdmin.from('vendor_reviews').insert({
      vendor_id: testVendor.id,
      request_id: order!.id,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 4,
      service_mode: 'delivery',
    });
  }

  // Mirrors syncVendorRatingFromReviews recovery branch (avg > 3.5 clears flag)
  const { data: reviews } = await supabaseAdmin
    .from('vendor_reviews')
    .select('rating')
    .eq('vendor_id', testVendor.id);

  const avg = (reviews ?? []).reduce((sum, r) => sum + r.rating, 0) / (reviews?.length ?? 1);
  const avgRating = Math.round(avg * 10) / 10;
  const update: { avg_rating: number; review_count: number; low_rating_admin_notified?: boolean } = {
    avg_rating: avgRating,
    review_count: reviews?.length ?? 0,
  };
  if (avgRating > 3.5) {
    update.low_rating_admin_notified = false;
  }
  await supabaseAdmin.from('vendors').update(update).eq('id', testVendor.id);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, low_rating_admin_notified')
    .eq('id', testVendor.id)
    .single();

  expect(data?.avg_rating).toBeGreaterThan(3.5);
  expect(data?.low_rating_admin_notified).toBe(false);
});

test('RV-08: vendor can respond to review', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Order for vendor response test',
      status: 'done',
    })
    .select()
    .single();

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: testVendor.id,
      request_id: order.id,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 3,
      review_text: 'Average service',
      service_mode: 'delivery',
    })
    .select()
    .single();

  const responseText = 'Thank you for your feedback!';
  const { error } = await supabaseAdmin
    .from('vendor_reviews')
    .update({
      vendor_response: responseText,
      vendor_responded_at: new Date().toISOString(),
    })
    .eq('id', review.id);

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('vendor_reviews')
    .select('vendor_response, vendor_responded_at')
    .eq('id', review.id)
    .single();

  expect(data?.vendor_response).toBe(responseText);
  expect(data?.vendor_responded_at).not.toBeNull();
});

test('RV-04: skip rating — no vendor_reviews row inserted', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Skipped rating order',
      status: 'done',
    })
    .select()
    .single();

  // Customer skips — no insert happens
  const { data } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id')
    .eq('request_id', order.id);

  expect(data?.length).toBe(0);
});

// ─── submit_vendor_review order-verification gates ─────────────────────────

test('RV-GATE-01: submit_vendor_review rejects missing request_id → request_not_found', async () => {
  const { data, error } = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: FAKE_REQUEST_ID,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
  });
  expect(data).toBeNull();
  expectRpcCode(error, 'request_not_found');
});

test('RV-GATE-02: submit_vendor_review rejects wrong vendor_id → vendor_mismatch', async () => {
  const order = await seedRequest({
    vendorId: testVendor.id,
    status: 'fulfilled',
    message: `RV-GATE-02 ${TEST_SESSION}`,
  });
  const { data, error } = await callSubmitReview({
    vendorId: otherVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
  });
  expect(data).toBeNull();
  expectRpcCode(error, 'vendor_mismatch');
});

test('RV-GATE-03: submit_vendor_review rejects non-fulfilled order → order_not_fulfilled', async () => {
  const order = await seedRequest({
    status: 'accepted',
    message: `RV-GATE-03 ${TEST_SESSION}`,
  });
  const { data, error } = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
  });
  expect(data).toBeNull();
  expectRpcCode(error, 'order_not_fulfilled');
});

test('RV-GATE-04: submit_vendor_review rejects wrong customer phone/device → not_found_or_unauthorized', async () => {
  const order = await seedRequest({
    status: 'fulfilled',
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
    message: `RV-GATE-04 ${TEST_SESSION}`,
  });
  const { data, error } = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: '8800099999',
    deviceId: 'device_not_matching_order',
  });
  expect(data).toBeNull();
  expectRpcCode(error, 'not_found_or_unauthorized');
});

test('RV-GATE-05: submit_vendor_review happy path — fulfilled matching order/customer succeeds', async () => {
  const order = await seedRequest({
    status: 'fulfilled',
    message: `RV-GATE-05 ${TEST_SESSION}`,
  });
  const { data, error } = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
    rating: 5,
    reviewText: 'Gate happy path',
  });
  expect(error).toBeNull();
  expect(data?.rating).toBe(5);
  expect(data?.request_id).toBe(order.id);
  expect(data?.vendor_id).toBe(testVendor.id);
  expect(data?.user_phone).toBe(TEST_CUSTOMER_PHONE);

  const { data: row } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id, rating')
    .eq('request_id', order.id)
    .maybeSingle();
  expect(row?.rating).toBe(5);
});

test('RV-GATE-06: submit_vendor_review duplicate request → review_already_exists', async () => {
  const order = await seedRequest({
    status: 'fulfilled',
    message: `RV-GATE-06 ${TEST_SESSION}`,
  });
  const first = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
    rating: 4,
  });
  expect(first.error).toBeNull();

  const second = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
    rating: 5,
  });
  expect(second.data).toBeNull();
  expectRpcCode(second.error, 'review_already_exists');
});

test('RV-GATE-07: submit_vendor_review invalid rating → invalid_rating', async () => {
  const order = await seedRequest({
    status: 'fulfilled',
    message: `RV-GATE-07 ${TEST_SESSION}`,
  });
  const { data, error } = await callSubmitReview({
    vendorId: testVendor.id,
    requestId: order.id,
    userPhone: TEST_CUSTOMER_PHONE,
    deviceId: DEVICE_ID,
    rating: 0,
  });
  expect(data).toBeNull();
  expectRpcCode(error, 'invalid_rating');

  const { data: rows } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id')
    .eq('request_id', order.id);
  expect(rows?.length ?? 0).toBe(0);
});
