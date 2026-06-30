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

function uniqueVendorPhone(): string {
  return `99006${Date.now().toString().slice(-5)}${Math.floor(Math.random() * 10)}`;
}

/** Mirrors RadarSearch.tsx vendor_categories → vendor_id filter (category + mode search path). */
async function radarVendorIdsForCategories(
  categoryIds: string[],
  selectedMode?: string,
): Promise<string[]> {
  let q = supabase
    .from('vendor_categories')
    .select('vendor_id')
    .in('category_id', categoryIds)
    .eq('status', 'approved');
  if (selectedMode) {
    q = q.eq('service_mode', selectedMode);
  }
  const { data, error } = await q;
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.vendor_id))];
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

async function vendorVisibleInRadarCategorySearch(
  vendorId: string,
  categoryId: string,
  selectedMode: string,
): Promise<boolean> {
  const vcFilter = await radarVendorIdsForCategories([categoryId], selectedMode);
  if (!vcFilter.includes(vendorId)) return false;
  const modeMatches = await radarVendorIdsForMode(selectedMode, vcFilter, true);
  return modeMatches.includes(vendorId);
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
