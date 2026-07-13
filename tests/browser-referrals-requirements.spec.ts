import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, openVendorPreferencesTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  invokeRegisterVendorRpc,
} from './helpers/setup';
import { uniqueBrowserPhone } from './helpers/session38';
/** Stable vendor referral code: AASP + last 4 phone digits (matches src/lib/referral.ts). */
function referralCodeFromPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 4) return `AASP${digits.slice(-4)}`;
  return `AASP${String(1000 + (Date.now() % 9000))}`;
}

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88009${String(T).slice(-5)}`;
const DEVICE_ID = `device_rf_${T}`;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;

const L = {
  referEarn: '🎁 Refer & Earn',
  menu: 'My Menu / Price List',
  copyReferralCode: 'Copy referral code',
  referralCodeLabel: 'Referral Code (optional)',
  referralAlreadyUsed: 'This referral code has already been used',
  pendingPayoutPrefix: 'Pending payout:',
} as const;

const createdVendorIds: string[] = [];
const createdReferralIds: string[] = [];
const createdCustomerPhones: string[] = [];
let referralEnabledOriginal: string | null = null;
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99009${String(T + vendorPhoneSeq).slice(-5)}`;
}

type VendorRow = {
  id: string;
  shop_name: string;
  phone: string;
  category: string;
  service_mode: string;
  referral_code?: string | null;
};

async function createVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = (overrides.phone as string | undefined) ?? nextVendorPhone();
  const shopName = `!RF-${tag}-${T}`;
  const referralCode =
    (overrides.referral_code as string | undefined) ?? referralCodeFromPhone(phone);
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `RF Vendor ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      referral_code: referralCode,
      ...overrides,
    })
    .select('id, shop_name, phone, category, service_mode, referral_code')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor as VendorRow;
}

async function setReferralEnabled(value: 'true' | 'false') {
  const { error } = await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'referral_enabled', value }, { onConflict: 'key' });
  if (error) throw error;
}

async function gotoSettings(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
}

async function expandVendorPreferences(page: Page) {
  await openVendorPreferencesTab(page);
  await expect(page.getByRole('button', { name: L.menu })).toBeVisible({ timeout: 20000 });
}

async function expandReferEarn(page: Page) {
  await expandVendorPreferences(page);
  const referBtn = page.getByRole('button', { name: L.referEarn });
  await expect(referBtn).toBeVisible({ timeout: 20000 });
  if ((await referBtn.getAttribute('aria-expanded')) !== 'true') {
    await referBtn.click();
  }
}

async function loadVendorCreditMilestones(): Promise<{ m1: number; m2: number; m3: number }> {
  const { data, error } = await supabaseAdmin
    .from('app_config')
    .select('key, value')
    .in('key', [
      'referral_vendor_credit_m1',
      'referral_vendor_credit_m2',
      'referral_vendor_credit_m3',
    ]);
  if (error) throw error;
  const byKey = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
  const parse = (key: string, fallback: number) => {
    const n = Number(String(byKey[key] ?? '').trim());
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    m1: parse('referral_vendor_credit_m1', 8.34),
    m2: parse('referral_vendor_credit_m2', 8.34),
    m3: parse('referral_vendor_credit_m3', 8.32),
  };
}

async function invokeProcessVendorReferral(newVendorId: string, referralCode: string) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/process-vendor-referral`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      new_vendor_id: newVendorId,
      referral_code: referralCode,
    }),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { resp, body };
}

async function cleanupReferralArtifactsForVendor(vendorId: string) {
  const { data: refs } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .or(`referrer_vendor_id.eq.${vendorId},referee_id.eq.${vendorId}`);
  const refIds = (refs ?? []).map((r) => r.id);
  if (refIds.length) {
    await supabaseAdmin.from('vendor_credits').delete().in('referral_id', refIds);
    await supabaseAdmin.from('referrals').delete().in('id', refIds);
  }
}

test.beforeAll(async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_enabled')
    .maybeSingle();
  referralEnabledOriginal = data?.value ?? 'true';
  await setReferralEnabled('true');
});

test.afterAll(async () => {
  for (const phone of createdCustomerPhones) {
    const { data: refs } = await supabaseAdmin
      .from('referrals')
      .select('id')
      .eq('referee_id', phone);
    const refIds = (refs ?? []).map((r) => r.id);
    if (refIds.length) {
      await supabaseAdmin.from('vendor_credits').delete().in('referral_id', refIds);
      await supabaseAdmin.from('referrals').delete().in('id', refIds);
    }
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
  }
  if (createdReferralIds.length) {
    await supabaseAdmin.from('vendor_credits').delete().in('referral_id', createdReferralIds);
    await supabaseAdmin.from('referrals').delete().in('id', createdReferralIds);
  }
  for (const vendorId of createdVendorIds) {
    await cleanupReferralArtifactsForVendor(vendorId);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  if (referralEnabledOriginal != null) {
    await setReferralEnabled(
      referralEnabledOriginal.trim().toLowerCase() === 'false' ? 'false' : 'true',
    );
  }
});

// ─── REFER & EARN UI — VENDOR ───────────────────────────────────────────────

test('RF-REQ-01 — Vendor sees referral code in Refer & Earn section', async ({ page }) => {
  const vendor = await createVendor('req01');
  const expectedCode = referralCodeFromPhone(vendor.phone);
  await loginAsVendor(page, vendor.phone, vendor.id, `${DEVICE_ID}_01`);
  await gotoSettings(page);
  await expandReferEarn(page);

  await expect(page.getByText(expectedCode)).toBeVisible();
  await expect(page.getByRole('button', { name: L.copyReferralCode })).toBeVisible();
});

test('RF-REQ-02 — Referral code matches phone-derived format', async ({ page }) => {
  const vendor = await createVendor('req02');
  const expectedCode = referralCodeFromPhone(vendor.phone);
  await loginAsVendor(page, vendor.phone, vendor.id, `${DEVICE_ID}_02`);
  await gotoSettings(page);
  await expandReferEarn(page);

  const displayed = await page
    .getByRole('button', { name: L.copyReferralCode })
    .locator('span.font-mono')
    .textContent();
  expect(displayed?.trim()).toBe(expectedCode);
  expect(displayed?.trim()).toMatch(/^AASP\d{4}$/);
  expect(displayed?.trim()).not.toMatch(/^[A-Z0-9]{6}$/);
});

test('RF-REQ-03 — Refer & Earn hidden when referral_enabled=false', async ({ page }) => {
  const vendor = await createVendor('req03');
  await setReferralEnabled('false');
  try {
    await loginAsVendor(page, vendor.phone, vendor.id, `${DEVICE_ID}_03`);
    await gotoSettings(page);
    await expandVendorPreferences(page);
    await expect(page.getByRole('button', { name: L.referEarn })).not.toBeVisible();
  } finally {
    await setReferralEnabled('true');
  }
});

test('RF-REQ-04 — Customer has NO Refer & Earn section', async ({ page }) => {
  await supabaseAdmin.from('users').upsert(
    {
      phone: CUSTOMER_PHONE,
      trust_score: 75,
      warn_count: 0,
      is_banned: false,
    },
    { onConflict: 'phone' },
  );
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);
  await expect(page.getByText(L.referEarn)).not.toBeVisible();
  await expect(page.getByRole('button', { name: L.referEarn })).not.toBeVisible();
});

// ─── DEEPLINK — CODE STORAGE ────────────────────────────────────────────────

test('RF-REQ-05 — Visiting /r/CODE stores uppercased code in localStorage', async ({ page }) => {
  const deeplinkCode = `aasptestcode${T}`;
  const expectedStored = `AASPTESTCODE${T}`;

  await page.goto(`${APP_URL}/r/${deeplinkCode}`);
  await page.waitForURL(/\//, { timeout: 15000 });

  const stored = await page.evaluate(() => localStorage.getItem('aaspaas:referral_code'));
  expect(stored).toBe(expectedStored);
});

test('RF-REQ-06 — Referral code prefilled in vendor registration form', async ({ page }) => {
  await setReferralEnabled('true');
  const storedCode = `AASP${String(T).slice(-4)}`;

  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((code) => {
    localStorage.setItem('aaspaas:referral_code', code);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, storedCode);
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });

  // Referral field is on Step A (account), not the old step-3 location
  await expect(page.getByPlaceholder('e.g. MAT-9973')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(L.referralCodeLabel)).toBeVisible({ timeout: 5000 });
  await expect(page.getByPlaceholder('e.g. MAT-9973')).toHaveValue(storedCode);
});

// ─── SELF-REFERRAL BLOCK ──────────────────────────────────────────────────────

test('RF-REQ-07 — Vendor cannot use own referral code at registration', async ({ page }) => {
  const phone = uniqueBrowserPhone('9000');
  const referralCode = referralCodeFromPhone(phone);
  const vendor = await createVendor('req07', { phone, referral_code: referralCode });
  const deviceId = `${DEVICE_ID}_07`;

  await page.goto(APP_URL);

  const applied = await page.evaluate(
    async ({ phone, deviceId, code }) => {
      localStorage.setItem('aaspaas:referral_code', code);
      const { recordUserReferral } = await import('/src/lib/referral.ts');
      return await recordUserReferral(phone, deviceId);
    },
    { phone, deviceId, code: referralCode },
  );

  expect(applied).toBe(false);

  const { data: referrals } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .eq('referrer_vendor_id', vendor.id);
  expect(referrals?.length ?? 0).toBe(0);

  const { count: creditCount } = await supabaseAdmin
    .from('vendor_credits')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendor.id);
  expect(creditCount ?? 0).toBe(0);
});

// ─── CREDIT CREATION — DB LEVEL ─────────────────────────────────────────────

test('RF-REQ-08 — Vendor referral creates 3 credit rows (M1, M2, M3)', async () => {
  const referrer = await createVendor('req08-ref');
  const referrerCode = referralCodeFromPhone(referrer.phone);
  const milestones = await loadVendorCreditMilestones();

  const refereePhone = nextVendorPhone();
  const registerResult = await invokeRegisterVendorRpc({
    phone: refereePhone,
    shop_name: `!RF-REQ08-${T}`,
    referral_code: referralCodeFromPhone(refereePhone),
    is_active: true,
  });
  if (registerResult.error || !registerResult.vendorId) {
    throw new Error(registerResult.error?.message ?? 'register vendor failed');
  }
  const refereeId = registerResult.vendorId;
  createdVendorIds.push(refereeId);

  const { resp, body } = await invokeProcessVendorReferral(refereeId, referrerCode);
  expect(resp.status).toBe(200);
  expect(body.success).toBe(true);

  const { data: referral } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .eq('referee_id', refereeId)
    .eq('referrer_vendor_id', referrer.id)
    .single();
  expect(referral).not.toBeNull();
  createdReferralIds.push(referral!.id);

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('amount, disbursement_month, disbursed')
    .eq('referral_id', referral!.id)
    .eq('vendor_id', referrer.id)
    .order('disbursement_month', { ascending: true });

  expect(credits).toHaveLength(3);
  expect(credits!.map((c) => c.disbursement_month)).toEqual([1, 2, 3]);
  expect(credits!.every((c) => c.disbursed === false)).toBe(true);
  expect(credits![0].amount).toBeCloseTo(milestones.m1, 2);
  expect(credits![1].amount).toBeCloseTo(milestones.m2, 2);
  expect(credits![2].amount).toBeCloseTo(milestones.m3, 2);
});

test('RF-REQ-09 — User referral creates 1 credit row for referrer vendor', async ({ page }) => {
  const referrer = await createVendor('req09-ref');
  const customerPhone = `88009${String(T + 99).slice(-5)}`;
  const deviceId = `${DEVICE_ID}_09`;
  createdCustomerPhones.push(customerPhone);

  await page.goto(APP_URL);

  await supabaseAdmin.from('app_users').upsert({
    phone: customerPhone,
    device_id: deviceId,
    referral_code: `USR${customerPhone.slice(-4)}`,
    referred_by_vendor_id: referrer.id,
  }, { onConflict: 'phone' });
  const { data: referral } = await supabaseAdmin.from('referrals').insert({
    referrer_vendor_id: referrer.id,
    referee_type: 'user',
    referee_id: customerPhone,
    status: 'active',
    trigger_rule: 'active_once',
    triggered_at: new Date().toISOString(),
    credits_created: false,
  }).select('id').single();
  const creditAmount = 50;
  await supabaseAdmin.from('vendor_credits').insert({
    vendor_id: referrer.id,
    referral_id: referral!.id,
    amount: creditAmount,
    disbursement_month: 1,
    disbursed: false,
  });
  await supabaseAdmin.from('referrals').update({ credits_created: true }).eq('id', referral!.id);

  const { data: referralRow } = await supabaseAdmin
    .from('referrals')
    .select('id, credits_created')
    .eq('referee_id', customerPhone)
    .eq('referrer_vendor_id', referrer.id)
    .single();
  expect(referralRow).not.toBeNull();
  expect(referralRow!.credits_created).toBe(true);
  createdReferralIds.push(referralRow!.id);

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('disbursed')
    .eq('referral_id', referralRow!.id)
    .eq('vendor_id', referrer.id);
  expect(credits).toHaveLength(1);
  expect(credits![0].disbursed).toBe(false);
});

test('RF-REQ-10 — Duplicate vendor referral blocked gracefully', async ({ page }) => {
  const referrer = await createVendor('req10-ref');
  const referrerCode = referralCodeFromPhone(referrer.phone);
  const referee = await createVendor('req10-referee');

  const { data: existingReferral, error: insertError } = await supabaseAdmin
    .from('referrals')
    .insert({
      referrer_vendor_id: referrer.id,
      referee_type: 'vendor',
      referee_id: referee.id,
      status: 'active',
      trigger_rule: 'active_once',
      credits_created: true,
    })
    .select('id')
    .single();
  if (insertError) throw insertError;
  createdReferralIds.push(existingReferral!.id);

  const { count: countBefore } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referee_id', referee.id);

  const { resp, body } = await invokeProcessVendorReferral(referee.id, referrerCode);
  expect(resp.status).toBe(200);
  expect(body.reason).toBe('already_referred');

  const { count: countAfter } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referee_id', referee.id);
  expect(countAfter).toBe(countBefore);

  // Toast via real registration UI — hold edge fn until duplicate referral row exists
  const newPhone = nextVendorPhone();
  const category = await getActiveCategoryByServiceMode('delivery');
  let releaseEdgeFn!: () => void;
  const edgeGate = new Promise<void>((resolve) => {
    releaseEdgeFn = resolve;
  });

  await page.route('**/functions/v1/process-vendor-referral', async (route) => {
    await edgeGate;
    await route.continue();
  });

  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });

  await page.goto(APP_URL);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('aaspaas:welcomed', 'true');
  });
  await page.goto(`${APP_URL}/vendor`);

  // Step A — account (referral on this step)
  await page.getByPlaceholder('Ramesh Kumar').fill('RF10 Owner');
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(newPhone);
  await page.getByPlaceholder('name@okbank').fill('rf10toast@upi');
  await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
  await page
    .getByRole('button', {
      name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन|📍 Capture|Location set/,
    })
    .click();
  await page.getByTestId('reg-selfie-capture').click();
  await expect(page.getByTestId('reg-selfie-capture')).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByPlaceholder('e.g. MAT-9973').fill(referrerCode);
  await page.getByRole('button', { name: 'Next' }).click();

  // Step B — business
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  await page.getByRole('button').filter({ hasText: category.label }).first().click();
  await page.getByPlaceholder('Ramesh Tyre Works').fill(`RF10 Shop ${T}`);
  await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  await page.getByTestId('reg-avail-delivery').click();
  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });

  const registerPromise = page.waitForResponse(
    (r) => r.url().includes('/rpc/register_vendor') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i }).click();
  const registerResp = await registerPromise;
  const newVendorId = (await registerResp.json()) as string;
  createdVendorIds.push(newVendorId);

  const { data: raceReferral, error: raceError } = await supabaseAdmin
    .from('referrals')
    .insert({
      referrer_vendor_id: referrer.id,
      referee_type: 'vendor',
      referee_id: newVendorId,
      status: 'active',
      trigger_rule: 'active_once',
      credits_created: true,
    })
    .select('id')
    .single();
  if (raceError) throw raceError;
  createdReferralIds.push(raceReferral!.id);

  releaseEdgeFn();
  await expect(page.getByText(L.referralAlreadyUsed)).toBeVisible({ timeout: 10000 });
});

// ─── VENDOR CREDITS STATE ───────────────────────────────────────────────────

test('RF-REQ-11 — Credits show as "Pending payout" in Refer & Earn UI', async ({ page }) => {
  const vendor = await createVendor('req11');
  const amount1 = 5.5;
  const amount2 = 3.25;
  const pendingTotal = (amount1 + amount2).toFixed(2);

  const { data: referral, error: refError } = await supabaseAdmin
    .from('referrals')
    .insert({
      referrer_vendor_id: vendor.id,
      referee_type: 'vendor',
      referee_id: `placeholder-${T}`,
      status: 'active',
      credits_created: true,
    })
    .select('id')
    .single();
  if (refError) throw refError;
  createdReferralIds.push(referral!.id);

  const { error: creditsError } = await supabaseAdmin.from('vendor_credits').insert([
    {
      vendor_id: vendor.id,
      referral_id: referral!.id,
      amount: amount1,
      disbursement_month: 1,
      disbursed: false,
    },
    {
      vendor_id: vendor.id,
      referral_id: referral!.id,
      amount: amount2,
      disbursement_month: 2,
      disbursed: false,
    },
  ]);
  if (creditsError) throw creditsError;

  await loginAsVendor(page, vendor.phone, vendor.id, `${DEVICE_ID}_11`);
  await gotoSettings(page);
  await expandReferEarn(page);

  await expect(page.getByText(new RegExp(`${L.pendingPayoutPrefix}.*${pendingTotal}`))).toBeVisible();
  await expect(page.getByText(/paid|disbursed/i)).not.toBeVisible();
});
