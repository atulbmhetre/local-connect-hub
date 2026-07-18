import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
  getActiveCategoryByServiceMode,
  getActiveCategories,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';

let phoneSeq = Math.floor(Math.random() * 100);
function uniqueVendorPhone(): string {
  // 10-digit phone: 99006 + 3 time digits + 2 monotonic-sequence digits.
  // The per-process sequence guarantees uniqueness for back-to-back calls in the
  // same millisecond (e.g. two vendors registered in one test).
  phoneSeq = (phoneSeq + 1) % 100;
  const timePart = Date.now().toString().slice(-3);
  const seqPart = phoneSeq.toString().padStart(2, '0');
  return `99006${timePart}${seqPart}`;
}

/** Mirrors RadarSearch.tsx membership RPC (category + mode search path). */
async function radarVendorIdsForCategories(
  categoryIds: string[],
  selectedMode?: string,
): Promise<string[]> {
  if (!selectedMode) {
    const { data, error } = await supabase
      .from('vendor_categories')
      .select('vendor_id')
      .in('category_id', categoryIds)
      .eq('status', 'approved');
    if (error) throw error;
    return [...new Set((data ?? []).map((row) => row.vendor_id))];
  }
  const { data, error } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: selectedMode,
    p_category_ids: categoryIds,
  });
  if (error) throw error;
  return [...new Set((data ?? []).map((row: { vendor_id: string }) => row.vendor_id))];
}

/** Mirrors RadarSearch.tsx vendors query (track B / pan-India path, no GPS bbox). */
async function radarVendorIdsForMode(
  selectedMode: string,
  vendorIdFilter: string[] | null,
  categoryModeSearch = false,
): Promise<string[]> {
  let q = supabase
    .from('vendors')
    .select('id')
    .eq('is_banned', false)
    .eq('profile_status', 'complete')
    .eq('service_radius_km', 9999);

  if (!categoryModeSearch) {
    q = q.eq('service_mode', selectedMode);
  }

  if (selectedMode === 'help') {
    q = q.eq('is_active', true);
  }
  if (vendorIdFilter && vendorIdFilter.length > 0) {
    q = q.in('id', vendorIdFilter);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

/** Single-vendor check — avoids PostgREST Bad Request when a category has hundreds of vendors. */
async function vendorMatchesRadarPanIndiaFilters(
  vendorId: string,
  selectedMode: string,
  categoryModeSearch: boolean,
): Promise<boolean> {
  let q = supabase
    .from('vendors')
    .select('id')
    .eq('id', vendorId)
    .eq('is_banned', false)
    .eq('profile_status', 'complete')
    .eq('service_radius_km', 9999);

  if (!categoryModeSearch) {
    q = q.eq('service_mode', selectedMode);
  }
  if (selectedMode === 'help') {
    q = q.eq('is_active', true);
  }

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return !!data;
}

async function vendorVisibleInRadarCategorySearch(
  vendorId: string,
  categoryId: string,
  selectedMode: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: selectedMode,
    p_category_ids: [categoryId],
  });
  if (error) throw error;
  const matched = (data ?? []).some(
    (row: { vendor_id: string }) => row.vendor_id === vendorId,
  );
  if (!matched) return false;
  return vendorMatchesRadarPanIndiaFilters(vendorId, selectedMode, true);
}

/** Mirrors RadarSearch.tsx empty-browse path via category-mode membership RPC. */
async function vendorVisibleInRadarEmptyBrowse(
  vendorId: string,
  selectedMode: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: selectedMode,
    p_category_ids: null,
  });
  if (error) throw error;
  const matched = (data ?? []).some(
    (row: { vendor_id: string }) => row.vendor_id === vendorId,
  );
  if (!matched) return false;
  return vendorMatchesRadarPanIndiaFilters(vendorId, selectedMode, true);
}

test.afterAll(async () => {
  await cleanupTestVendors();
});

test('MCV-01: register_vendor with 2 categories — primary flag and row count', async () => {
  const categories = await getActiveCategories(2);
  expect(categories.length).toBeGreaterThanOrEqual(2);

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: categories[0].label,
    service_mode: categories[0].service_mode,
    category_ids: [categories[0].id, categories[1].id],
    category_service_modes: [categories[0].service_mode, categories[1].service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('category_id, is_primary, service_mode')
      .eq('vendor_id', vendorId)
      .order('is_primary', { ascending: false });
    expect(error).toBeNull();
    expect(rows?.length).toBe(2);
    expect(rows?.[0]?.is_primary).toBe(true);
    expect(rows?.[0]?.category_id).toBe(categories[0].id);
    expect(rows?.[1]?.is_primary).toBe(false);
    expect(rows?.[1]?.category_id).toBe(categories[1].id);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-02: register_vendor with 3 categories sets needs_review on all rows', async () => {
  const categories = await getActiveCategories(3);
  expect(categories.length).toBeGreaterThanOrEqual(3);

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: categories[0].label,
    service_mode: categories[0].service_mode,
    category_ids: categories.map((c) => c.id),
    category_service_modes: categories.map((c) => c.service_mode),
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('needs_review')
      .eq('vendor_id', vendorId);
    expect(error).toBeNull();
    expect(rows?.length).toBe(3);
    expect(rows?.every((row) => row.needs_review === true)).toBe(true);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-03: register_vendor rejects mismatched category array lengths', async () => {
  const categories = await getActiveCategories(2);
  expect(categories.length).toBeGreaterThanOrEqual(2);

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category_ids: [categories[0].id, categories[1].id],
    category_service_modes: [categories[0].service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
  });

  expect(result.vendorId).toBeUndefined();
  expect(result.error?.message).toMatch(/category_service_modes length must match category_ids length/i);
});

test('MCV-04: multi-category vendor stores distinct labels and service modes per row', async () => {
  const helpCat = await getActiveCategoryByServiceMode('help');
  const deliveryCat = await getActiveCategoryByServiceMode('delivery');

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: helpCat.label,
    service_mode: helpCat.service_mode,
    category_ids: [helpCat.id, deliveryCat.id],
    category_service_modes: ['help', 'delivery'],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('service_mode, is_primary, categories(label)')
      .eq('vendor_id', vendorId)
      .order('is_primary', { ascending: false });
    expect(error).toBeNull();
    expect(rows?.length).toBe(2);

    const primary = rows![0];
    const secondary = rows![1];
    const primaryLabel = Array.isArray(primary.categories)
      ? primary.categories[0]?.label
      : (primary.categories as { label: string } | null)?.label;
    const secondaryLabel = Array.isArray(secondary.categories)
      ? secondary.categories[0]?.label
      : (secondary.categories as { label: string } | null)?.label;

    expect(primaryLabel).toBe(helpCat.label);
    expect(primary.service_mode).toBe('help');
    expect(secondaryLabel).toBe(deliveryCat.label);
    expect(secondary.service_mode).toBe('delivery');
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-05: radar category filter finds multi-category vendor under each category', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = uniqueVendorPhone();
  const shopName = `!MCV05-${Date.now()}`;

  const result = await invokeRegisterVendorRpc({
    phone,
    shop_name: shopName,
    category: electrician.label,
    service_mode: electrician.service_mode,
    category_ids: [electrician.id, plumber.id],
    category_service_modes: [electrician.service_mode, plumber.service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
    latitude: 18.5204,
    longitude: 73.8567,
    profile_status: 'complete',
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    await supabaseAdmin
      .from('vendors')
      .update({
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
      })
      .eq('id', vendorId);

    const electricianMatches = await radarVendorIdsForCategories([electrician.id]);
    expect(electricianMatches).toContain(vendorId);

    const plumberMatches = await radarVendorIdsForCategories([plumber.id]);
    expect(plumberMatches).toContain(vendorId);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-06: delete-all + re-insert leaves exactly one vendor_categories row', async () => {
  const categories = await getActiveCategories(2);
  expect(categories.length).toBeGreaterThanOrEqual(2);

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: categories[0].label,
    service_mode: categories[0].service_mode,
    category_ids: [categories[0].id, categories[1].id],
    category_service_modes: [categories[0].service_mode, categories[1].service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { error: delError } = await supabaseAdmin
      .from('vendor_categories')
      .delete()
      .eq('vendor_id', vendorId);
    expect(delError).toBeNull();

    const { error: insError } = await supabaseAdmin.from('vendor_categories').insert({
      vendor_id: vendorId,
      category_id: categories[0].id,
      is_primary: true,
      status: 'approved',
      needs_review: false,
      service_mode: categories[0].service_mode,
    });
    expect(insError).toBeNull();

    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('id, category_id')
      .eq('vendor_id', vendorId);
    expect(error).toBeNull();
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.category_id).toBe(categories[0].id);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-07: attach_pending_category replaces all vendor_categories rows', async () => {
  const categories = await getActiveCategories(2);
  expect(categories.length).toBeGreaterThanOrEqual(2);

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: categories[0].label,
    service_mode: categories[0].service_mode,
    category_ids: [categories[0].id, categories[1].id],
    category_service_modes: [categories[0].service_mode, categories[1].service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  const pendingLabel = `!MCV07-PENDING-${Date.now()}`;
  const { data: pendingCategory, error: catError } = await supabaseAdmin
    .from('categories')
    .insert({
      label: pendingLabel,
      emoji: '✨',
      service_mode: 'help',
      is_active: false,
      status: 'pending_review',
      sort_order: 999,
      pending_review: true,
      suggested_by_vendor_id: vendorId,
    })
    .select('id')
    .single();
  expect(catError).toBeNull();

  try {
    const { error: rpcError } = await supabase.rpc('attach_pending_category', {
      p_vendor_id: vendorId,
      p_category_id: pendingCategory!.id,
      p_service_mode: 'help',
      p_modes: ['help', 'delivery'],
    });
    expect(rpcError).toBeNull();

    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('category_id, is_primary, status')
      .eq('vendor_id', vendorId);
    expect(error).toBeNull();
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.category_id).toBe(pendingCategory!.id);
    expect(rows?.[0]?.is_primary).toBe(true);
    expect(rows?.[0]?.status).toBe('approved');
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
    await supabaseAdmin.from('categories').delete().eq('id', pendingCategory!.id);
  }
});

test('MCV-08: multi-mode vendor discoverability under help vs delivery radar tabs', async () => {
  const helpCat = await getActiveCategoryByServiceMode('help');
  const deliveryCat = await getActiveCategoryByServiceMode('delivery');

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: helpCat.label,
    service_mode: helpCat.service_mode,
    category_ids: [helpCat.id, deliveryCat.id],
    category_service_modes: ['help', 'delivery'],
    vendor_note: `test_session:${TEST_SESSION}`,
    profile_status: 'complete',
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    await supabaseAdmin
      .from('vendors')
      .update({
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
        latitude: 18.5204,
        longitude: 73.8567,
      })
      .eq('id', vendorId);

    const visibleInHelpTab = await vendorVisibleInRadarCategorySearch(
      vendorId,
      helpCat.id,
      'help',
    );
    expect(visibleInHelpTab).toBe(true);

    const vcFilterDelivery = await radarVendorIdsForCategories([deliveryCat.id], 'delivery');
    expect(vcFilterDelivery).toContain(vendorId);

    const visibleInDeliveryTab = await vendorVisibleInRadarCategorySearch(
      vendorId,
      deliveryCat.id,
      'delivery',
    );
    expect(visibleInDeliveryTab).toBe(true);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-10: shop vendor registers with sole delivery-mode category', async () => {
  const deliveryCat = await getActiveCategoryByServiceMode('delivery');
  const phone = uniqueVendorPhone();

  const result = await invokeRegisterVendorRpc({
    phone,
    vendor_type: 'shop',
    category: deliveryCat.label,
    service_mode: deliveryCat.service_mode,
    category_ids: [deliveryCat.id],
    category_service_modes: ['delivery'],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { data: vendor, error: vendorError } = await supabaseAdmin
      .from('vendors')
      .select('vendor_type, service_mode, category')
      .eq('id', vendorId)
      .single();
    expect(vendorError).toBeNull();
    expect(vendor?.vendor_type).toBe('shop');
    expect(vendor?.service_mode).toBe('delivery');
    expect(vendor?.category).toBe(deliveryCat.label);

    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('category_id, is_primary, service_mode')
      .eq('vendor_id', vendorId);
    expect(error).toBeNull();
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.category_id).toBe(deliveryCat.id);
    expect(rows?.[0]?.is_primary).toBe(true);
    expect(rows?.[0]?.service_mode).toBe('delivery');
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-11: shop vendor registers with sole appointment-mode category', async () => {
  const appointmentCat = await getActiveCategoryByServiceMode('appointment');
  const phone = uniqueVendorPhone();

  const result = await invokeRegisterVendorRpc({
    phone,
    vendor_type: 'shop',
    category: appointmentCat.label,
    service_mode: appointmentCat.service_mode,
    category_ids: [appointmentCat.id],
    category_service_modes: ['appointment'],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    const { data: vendor, error: vendorError } = await supabaseAdmin
      .from('vendors')
      .select('vendor_type, service_mode, category')
      .eq('id', vendorId)
      .single();
    expect(vendorError).toBeNull();
    expect(vendor?.vendor_type).toBe('shop');
    expect(vendor?.service_mode).toBe('appointment');
    expect(vendor?.category).toBe(appointmentCat.label);

    const { data: rows, error } = await supabaseAdmin
      .from('vendor_categories')
      .select('category_id, is_primary, service_mode')
      .eq('vendor_id', vendorId);
    expect(error).toBeNull();
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.category_id).toBe(appointmentCat.id);
    expect(rows?.[0]?.is_primary).toBe(true);
    expect(rows?.[0]?.service_mode).toBe('appointment');
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-09: multi-mode vendor visible on secondary mode tab during empty browse', async () => {
  const helpCat = await getActiveCategoryByServiceMode('help');
  const deliveryCat = await getActiveCategoryByServiceMode('delivery');

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: helpCat.label,
    service_mode: helpCat.service_mode,
    category_ids: [helpCat.id, deliveryCat.id],
    category_service_modes: ['help', 'delivery'],
    vendor_note: `test_session:${TEST_SESSION}`,
    profile_status: 'complete',
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    await supabaseAdmin
      .from('vendors')
      .update({
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
        latitude: 18.5204,
        longitude: 73.8567,
      })
      .eq('id', vendorId);

    const visibleOnHelpBrowse = await vendorVisibleInRadarEmptyBrowse(vendorId, 'help');
    expect(visibleOnHelpBrowse).toBe(true);

    const visibleOnDeliveryBrowse = await vendorVisibleInRadarEmptyBrowse(vendorId, 'delivery');
    expect(visibleOnDeliveryBrowse).toBe(true);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-12: help + appointment multi-mode vendor visible on both radar tabs', async () => {
  const helpCat = await getActiveCategoryByServiceMode('help');
  const appointmentCat = await getActiveCategoryByServiceMode('appointment');

  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: helpCat.label,
    service_mode: helpCat.service_mode,
    category_ids: [helpCat.id, appointmentCat.id],
    category_service_modes: ['help', 'appointment'],
    vendor_note: `test_session:${TEST_SESSION}`,
    profile_status: 'complete',
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  try {
    await supabaseAdmin
      .from('vendors')
      .update({
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
        latitude: 18.5204,
        longitude: 73.8567,
      })
      .eq('id', vendorId);

    expect(
      await vendorVisibleInRadarCategorySearch(vendorId, helpCat.id, 'help'),
    ).toBe(true);
    expect(
      await vendorVisibleInRadarCategorySearch(vendorId, appointmentCat.id, 'appointment'),
    ).toBe(true);
    expect(await vendorVisibleInRadarEmptyBrowse(vendorId, 'help')).toBe(true);
    expect(await vendorVisibleInRadarEmptyBrowse(vendorId, 'appointment')).toBe(true);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-13: create_customer_request stores searched category_id on request', async () => {
  test.setTimeout(90_000);
  const plumber = await getActiveCategoryByLabel('Plumber');
  const electrician = await getActiveCategoryByLabel('Electrician');
  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: plumber.label,
    service_mode: plumber.service_mode,
    category_ids: [plumber.id, electrician.id],
    category_service_modes: [plumber.service_mode, electrician.service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;

  // Approve both categories so p_category_id validation accepts the secondary.
  await supabaseAdmin
    .from('vendor_categories')
    .update({ status: 'approved', needs_review: false })
    .eq('vendor_id', vendorId);

  const customerPhone = `88013${Date.now().toString().slice(-5)}`;
  const customerDevice = `mcv13-cust-${Date.now()}`;

  try {
    await supabaseAdmin.from('users').upsert(
      { phone: customerPhone, trust_score: 75 },
      { onConflict: 'phone' },
    );

    const { data: requestId, error } = await supabaseAdmin.rpc('create_customer_request', {
      p_device_id: customerDevice,
      p_vendor_id: vendorId,
      p_message: 'MCV-13 category persist',
      p_user_phone: customerPhone,
      p_device_id_log: customerDevice,
      p_category_id: electrician.id,
      p_service_mode: electrician.service_mode,
    });
    expect(error, `create_customer_request: ${error?.message}`).toBeNull();
    expect(requestId).toBeTruthy();

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('requests')
      .select('id, category_id, vendor_id, service_mode')
      .eq('id', requestId as string)
      .single();
    expect(fetchErr).toBeNull();
    expect(row?.category_id).toBe(electrician.id);
    expect(row?.category_id).not.toBe(plumber.id);
    expect(row?.service_mode).toBe(electrician.service_mode);

    await supabaseAdmin.from('requests').delete().eq('id', requestId as string);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
  }
});

test('MCV-14: one category with help+delivery child modes is discoverable in both modes', async () => {
  const category = await getActiveCategoryByLabel('Cook');
  const phone = uniqueVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    category: category.label,
    service_mode: 'help',
    category_ids: [category.id],
    category_service_modes: ['help'],
    category_modes: { [category.id]: ['help', 'delivery'] },
    availability_modes: ['help', 'delivery'],
    service_radius_km: 9999,
    profile_status: 'complete',
  });
  expect(result.error).toBeUndefined();
  const vendorId = result.vendorId!;
  await supabaseAdmin.from('vendors').update({ is_active: true, discoverable: true }).eq('id', vendorId);

  try {
    const { data: modes } = await supabaseAdmin
      .from('vendor_category_modes')
      .select('mode')
      .eq('vendor_category_id', (
        await supabaseAdmin
          .from('vendor_categories')
          .select('id')
          .eq('vendor_id', vendorId)
          .eq('category_id', category.id)
          .single()
      ).data!.id);
    expect((modes ?? []).map((m) => m.mode).sort()).toEqual(['delivery', 'help']);

    expect(await vendorVisibleInRadarCategorySearch(vendorId, category.id, 'help')).toBe(true);
    expect(await vendorVisibleInRadarCategorySearch(vendorId, category.id, 'delivery')).toBe(true);
    expect(await vendorVisibleInRadarCategorySearch(vendorId, category.id, 'appointment')).toBe(false);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-15: category mode lookup never leaks a different vendor', async () => {
  const category = await getActiveCategoryByServiceMode('help');
  const phoneA = uniqueVendorPhone();
  const phoneB = uniqueVendorPhone();
  const a = await invokeRegisterVendorRpc({
    phone: phoneA,
    category: category.label,
    category_ids: [category.id],
    category_service_modes: ['help'],
    category_modes: { [category.id]: ['help', 'delivery'] },
    service_radius_km: 9999,
  });
  const b = await invokeRegisterVendorRpc({
    phone: phoneB,
    category: category.label,
    category_ids: [category.id],
    category_service_modes: ['help'],
    category_modes: { [category.id]: ['help'] },
    service_radius_km: 9999,
  });
  expect(a.error).toBeUndefined();
  expect(b.error).toBeUndefined();
  await supabaseAdmin
    .from('vendors')
    .update({ is_active: true, discoverable: true })
    .in('id', [a.vendorId!, b.vendorId!]);

  try {
    const ids = await radarVendorIdsForCategories([category.id], 'delivery');
    expect(ids).toContain(a.vendorId!);
    expect(ids).not.toContain(b.vendorId!);
  } finally {
    await deleteVendorRegistrationArtifacts(a.vendorId!);
    await deleteVendorRegistrationArtifacts(b.vendorId!);
  }
});

test('MCV-16: vendor_update_categories preserves child modes for retained rows', async () => {
  const cats = await getActiveCategories(2);
  const phone = uniqueVendorPhone();
  const reg = await invokeRegisterVendorRpc({
    phone,
    category: cats[0].label,
    category_ids: [cats[0].id],
    category_service_modes: ['help'],
    category_modes: { [cats[0].id]: ['help', 'appointment'] },
  });
  expect(reg.error).toBeUndefined();
  const vendorId = reg.vendorId!;

  try {
    const { data: beforeVc } = await supabaseAdmin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', vendorId)
      .eq('category_id', cats[0].id)
      .single();
    const beforeId = beforeVc!.id;

    const { error } = await supabaseAdmin.rpc('vendor_update_categories', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_category_ids: [cats[0].id, cats[1].id],
      p_category_service_modes: ['help', cats[1].service_mode],
      p_category_modes: {
        [cats[0].id]: ['help', 'appointment'],
        [cats[1].id]: [cats[1].service_mode],
      },
    });
    expect(error, error?.message).toBeNull();

    const { data: afterVc } = await supabaseAdmin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', vendorId)
      .eq('category_id', cats[0].id)
      .single();
    expect(afterVc?.id).toBe(beforeId);

    const { data: modes } = await supabaseAdmin
      .from('vendor_category_modes')
      .select('mode')
      .eq('vendor_category_id', beforeId);
    expect((modes ?? []).map((m) => m.mode).sort()).toEqual(['appointment', 'help']);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-17: vendor_sync_category_modes jsonb never flattens other categories', async () => {
  const cats = await getActiveCategories(2);
  const phone = uniqueVendorPhone();
  const reg = await invokeRegisterVendorRpc({
    phone,
    category: cats[0].label,
    category_ids: [cats[0].id, cats[1].id],
    category_service_modes: ['help', 'delivery'],
    category_modes: {
      [cats[0].id]: ['help', 'appointment'],
      [cats[1].id]: ['delivery'],
    },
  });
  expect(reg.error).toBeUndefined();
  const vendorId = reg.vendorId!;

  try {
    const { error } = await supabaseAdmin.rpc('vendor_sync_category_modes', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_category_modes: {
        [cats[0].id]: ['help'],
      },
    });
    expect(error, error?.message).toBeNull();

    const { data: vcRows } = await supabaseAdmin
      .from('vendor_categories')
      .select('id, category_id')
      .eq('vendor_id', vendorId);
    const vc0 = vcRows!.find((r) => r.category_id === cats[0].id)!;
    const vc1 = vcRows!.find((r) => r.category_id === cats[1].id)!;

    const { data: m0 } = await supabaseAdmin
      .from('vendor_category_modes')
      .select('mode')
      .eq('vendor_category_id', vc0.id);
    const { data: m1 } = await supabaseAdmin
      .from('vendor_category_modes')
      .select('mode')
      .eq('vendor_category_id', vc1.id);
    expect((m0 ?? []).map((m) => m.mode)).toEqual(['help']);
    expect((m1 ?? []).map((m) => m.mode)).toEqual(['delivery']);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});

test('MCV-18: register_vendor rejects missing/empty/mismatched category_modes', async () => {
  const cats = await getActiveCategories(2);
  const phone = uniqueVendorPhone();

  const missing = await supabaseAdmin.rpc('register_vendor', {
    p_name: 'Reject Modes',
    p_shop_name: 'Reject Shop',
    p_category: cats[0].label,
    p_phone: phone,
    p_upi_id: 'reject@upi',
    p_service_mode: 'help',
    p_vendor_type: 'shop',
    p_vendor_note: `test_session:${TEST_SESSION}`,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `R${Date.now().toString(36).slice(-6)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cats[0].id],
    p_category_service_modes: ['help'],
    p_category_modes: {},
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 15,
  });
  expect(missing.error?.message ?? '').toMatch(/category_modes_required|category_modes_missing/i);

  const emptyArr = await supabaseAdmin.rpc('register_vendor', {
    p_name: 'Reject Modes',
    p_shop_name: 'Reject Shop',
    p_category: cats[0].label,
    p_phone: uniqueVendorPhone(),
    p_upi_id: 'reject@upi',
    p_service_mode: 'help',
    p_vendor_type: 'shop',
    p_vendor_note: `test_session:${TEST_SESSION}`,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `R${Date.now().toString(36).slice(-6)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cats[0].id],
    p_category_service_modes: ['help'],
    p_category_modes: { [cats[0].id]: [] },
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 15,
  });
  expect(emptyArr.error?.message ?? '').toMatch(/category_modes_empty/i);

  const extra = await supabaseAdmin.rpc('register_vendor', {
    p_name: 'Reject Modes',
    p_shop_name: 'Reject Shop',
    p_category: cats[0].label,
    p_phone: uniqueVendorPhone(),
    p_upi_id: 'reject@upi',
    p_service_mode: 'help',
    p_vendor_type: 'shop',
    p_vendor_note: `test_session:${TEST_SESSION}`,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `R${Date.now().toString(36).slice(-6)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cats[0].id],
    p_category_service_modes: ['help'],
    p_category_modes: {
      [cats[0].id]: ['help'],
      [cats[1].id]: ['delivery'],
    },
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 15,
  });
  expect(extra.error?.message ?? '').toMatch(/category_modes_extra/i);
});

test('MCV-19: create_customer_request stores effective service_mode', async () => {
  const category = await getActiveCategoryByLabel('Cook');
  const phone = uniqueVendorPhone();
  const customerPhone = `880${Date.now().toString().slice(-7)}`;
  const customerDevice = `mcv18-${Date.now()}`;
  const reg = await invokeRegisterVendorRpc({
    phone,
    category: category.label,
    category_ids: [category.id],
    category_service_modes: ['help'],
    category_modes: { [category.id]: ['help', 'delivery'] },
  });
  expect(reg.error).toBeUndefined();
  const vendorId = reg.vendorId!;
  // asap delivery requires the vendor to be live and the category approved.
  await supabaseAdmin
    .from('vendors')
    .update({ is_active: true, discoverable: true })
    .eq('id', vendorId);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ status: 'approved', needs_review: false })
    .eq('vendor_id', vendorId);
  await supabaseAdmin.from('users').upsert({ phone: customerPhone, trust_score: 80 }, { onConflict: 'phone' });

  try {
    const { data: requestId, error } = await supabaseAdmin.rpc('create_customer_request', {
      p_device_id: customerDevice,
      p_vendor_id: vendorId,
      p_message: 'MCV-18 delivery via multi-mode',
      p_user_phone: customerPhone,
      p_device_id_log: customerDevice,
      p_category_id: category.id,
      p_service_mode: 'delivery',
      p_delivery_slot: 'asap',
    });
    expect(error, error?.message).toBeNull();

    const { data: row } = await supabaseAdmin
      .from('requests')
      .select('service_mode, category_id')
      .eq('id', requestId as string)
      .single();
    expect(row?.service_mode).toBe('delivery');
    expect(row?.category_id).toBe(category.id);

    const { error: badMode } = await supabaseAdmin.rpc('create_customer_request', {
      p_device_id: customerDevice,
      p_vendor_id: vendorId,
      p_message: 'MCV-18 unsupported mode',
      p_user_phone: customerPhone,
      p_category_id: category.id,
      p_service_mode: 'appointment',
    });
    expect(badMode?.message ?? '').toMatch(/service_mode_not_available_for_category/);

    await supabaseAdmin.from('requests').delete().eq('vendor_id', vendorId);
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
  }
});
