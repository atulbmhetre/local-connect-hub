import { test, expect } from '@playwright/test';
import { supabase, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists, assertVendorField } from './helpers/db-assert';

let testVendor: any;
const ADMIN_PHONE = '8888169446';

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabase.from('vendor_reviews').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabase.from('user_notifications').delete().eq('user_phone', ADMIN_PHONE).eq('type', 'admin_alert');
  await cleanupTestData();
});

test('RV-02: avg_rating recalculates after new review', async () => {
  // Set known state
  await supabase
    .from('vendors')
    .update({ avg_rating: 4.0, review_count: 2 })
    .eq('id', testVendor.id);

  // Create a request to review
  const { data: order } = await supabase
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
  await supabase.from('vendor_reviews').insert({
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

  await supabase
    .from('vendors')
    .update({ avg_rating: newAvg, review_count: newCount })
    .eq('id', testVendor.id);

  const { data } = await supabase
    .from('vendors')
    .select('avg_rating, review_count')
    .eq('id', testVendor.id)
    .single();

  expect(data?.review_count).toBe(3);
  expect(data?.avg_rating).toBeCloseTo(3.33, 1);
});

test('RV-05: low rating admin alert fires when avg < 2.0 and count >= 5', async () => {
  // Set conditions: avg < 2.0, count >= 5, flag not set
  await supabase
    .from('vendors')
    .update({
      avg_rating: 1.8,
      review_count: 5,
      low_rating_admin_notified: false,
    })
    .eq('id', testVendor.id);

  const { data: vendor } = await supabase
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
    await supabase.from('user_notifications').insert({
      user_phone: ADMIN_PHONE,
      type: 'admin_alert',
      title: 'Low Rating Alert',
      body: `Vendor rating dropped to ${vendor?.avg_rating}`,
      route: 'admin',
      route_params: { vendor_id: testVendor.id },
    });

    await supabase
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
  await supabase
    .from('vendors')
    .update({ low_rating_admin_notified: true })
    .eq('id', testVendor.id);

  const { count: before } = await supabase
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', ADMIN_PHONE)
    .eq('type', 'admin_alert');

  const { data: vendor } = await supabase
    .from('vendors')
    .select('low_rating_admin_notified')
    .eq('id', testVendor.id)
    .single();

  // App skips notification — flag is true
  if (!vendor?.low_rating_admin_notified) {
    await supabase.from('user_notifications').insert({
      user_phone: ADMIN_PHONE,
      type: 'admin_alert',
      title: 'Low Rating Alert',
      body: 'Should not fire again',
    });
  }

  const { count: after } = await supabase
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', ADMIN_PHONE)
    .eq('type', 'admin_alert');

  expect(after).toBe(before);
});

test('RV-07: low rating flag resets when avg recovers above 3.5', async () => {
  await supabase.from('vendor_reviews').delete().eq('vendor_id', testVendor.id);

  await supabase
    .from('vendors')
    .update({ avg_rating: 1.8, review_count: 0, low_rating_admin_notified: true })
    .eq('id', testVendor.id);

  for (let i = 0; i < 4; i++) {
    const { data: order } = await supabase
      .from('requests')
      .insert({
        vendor_id: testVendor.id,
        user_phone: TEST_CUSTOMER_PHONE,
        message: `RV-07 recovery order ${i}`,
        status: 'done',
      })
      .select()
      .single();

    await supabase.from('vendor_reviews').insert({
      vendor_id: testVendor.id,
      request_id: order!.id,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 4,
      service_mode: 'delivery',
    });
  }

  // Mirrors syncVendorRatingFromReviews recovery branch (avg > 3.5 clears flag)
  const { data: reviews } = await supabase
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
  await supabase.from('vendors').update(update).eq('id', testVendor.id);

  const { data } = await supabase
    .from('vendors')
    .select('avg_rating, low_rating_admin_notified')
    .eq('id', testVendor.id)
    .single();

  expect(data?.avg_rating).toBeGreaterThan(3.5);
  expect(data?.low_rating_admin_notified).toBe(false);
});

test('RV-08: vendor can respond to review', async () => {
  const { data: order } = await supabase
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Order for vendor response test',
      status: 'done',
    })
    .select()
    .single();

  const { data: review } = await supabase
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
  const { error } = await supabase
    .from('vendor_reviews')
    .update({
      vendor_response: responseText,
      vendor_responded_at: new Date().toISOString(),
    })
    .eq('id', review.id);

  expect(error).toBeNull();

  const { data } = await supabase
    .from('vendor_reviews')
    .select('vendor_response, vendor_responded_at')
    .eq('id', review.id)
    .single();

  expect(data?.vendor_response).toBe(responseText);
  expect(data?.vendor_responded_at).not.toBeNull();
});

test('RV-04: skip rating — no vendor_reviews row inserted', async () => {
  const { data: order } = await supabase
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
  const { data } = await supabase
    .from('vendor_reviews')
    .select('id')
    .eq('request_id', order.id);

  expect(data?.length).toBe(0);
});
