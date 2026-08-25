import { expect, Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { loginAsCustomer, mintBrowserSupabaseSession } from './setup';
import {
  getAnonKey,
  getAppUrl,
  getServiceRoleClient,
  getSupabaseUrl,
  loadTestEnv,
  withAuthAdminResultRetry,
} from './testEnv';

loadTestEnv();

export const APP_URL = getAppUrl();
export const RADAR_DELIVERY_URL = `${APP_URL}/radar?mode=delivery`;

/** Radar with delivery mode selected (default /radar is help-only). */
export async function gotoRadarDelivery(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.goto(RADAR_DELIVERY_URL, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

/** Click Order on a delivery/booking radar card (falls back to first orderable card). */
export async function clickRadarOrderCard(
  page: Page,
  options?: { vendorId?: string; shopName?: string },
) {
  if (options?.vendorId) {
    const byId = page.locator(`#radar-vendor-card-${options.vendorId}`);
    if (await byId.isVisible({ timeout: 3000 }).catch(() => false)) {
      await byId.getByTestId('radar-vendor-card-order-btn').click();
      return;
    }
  }
  if (options?.shopName) {
    const shopNames = [options.shopName, options.shopName.replace(/^!/, '')];
    for (const name of shopNames) {
      const byShop = page.getByTestId('radar-vendor-card').filter({ hasText: name });
      if (await byShop.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await byShop.first().getByTestId('radar-vendor-card-order-btn').click();
        return;
      }
    }
  }
  const card = page.getByTestId('radar-vendor-card').filter({
    has: page.getByTestId('radar-vendor-card-order-btn'),
  }).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByTestId('radar-vendor-card-order-btn').click();
}

export { loginAsCustomer };

/** Ephemeral TEST admin credentials when env is unset (never committed). */
const EPHEMERAL_ADMIN_EMAIL = 'playwright-admin-session@aaspaas.test';
const EPHEMERAL_ADMIN_PASSWORD = 'PlaywrightAdminSession!20260708';

function requireAdminCredentials(): { email: string; password: string } {
  const email = (process.env.TEST_ADMIN_EMAIL ?? '').trim() || EPHEMERAL_ADMIN_EMAIL;
  const password = (process.env.TEST_ADMIN_PASSWORD ?? '').trim() || EPHEMERAL_ADMIN_PASSWORD;
  if (!process.env.TEST_ADMIN_EMAIL || !process.env.TEST_ADMIN_PASSWORD) {
    process.env.TEST_ADMIN_EMAIL = email;
    process.env.TEST_ADMIN_PASSWORD = password;
  }
  return { email, password };
}

let ensureAdminUserPromise: Promise<void> | null = null;

/**
 * Create/link TEST admin auth user + admin_users row (idempotent).
 * Prefer password sign-in (stable) over Auth Admin listUsers — sb_secret Auth Admin is flaky
 * on this project after ES256 signing-key migration.
 */
export async function ensureTestAdminUser(): Promise<{ email: string; password: string }> {
  const creds = requireAdminCredentials();
  if (!ensureAdminUserPromise) {
    ensureAdminUserPromise = (async () => {
      const admin = getServiceRoleClient();
      const anon = createClient(getSupabaseUrl(), getAnonKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      let userId: string | null = null;

      // 1) Prefer sign-in — works when the ephemeral admin already exists (usual case).
      const { data: signedIn, error: signErr } = await anon.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      if (!signErr && signedIn.user?.id) {
        userId = signedIn.user.id;
      } else {
        // 2) Create via Auth Admin (retried — sb_secret Auth Admin is intermittently rejected).
        const { data: created, error: createErr } = await withAuthAdminResultRetry(
          'createUser',
          () =>
            admin.auth.admin.createUser({
              email: creds.email,
              password: creds.password,
              email_confirm: true,
            }),
        );
        if (createErr) {
          const msg = createErr.message.toLowerCase();
          if (!msg.includes('already') && !msg.includes('registered') && !msg.includes('exists')) {
            throw new Error(`createUser failed: ${createErr.message}`);
          }
          // 3) User exists but password may differ — try sign-in after reset is unavailable
          // without listUsers; re-sign-in after a short wait, else fail clearly.
          const { data: retrySign, error: retryErr } = await anon.auth.signInWithPassword({
            email: creds.email,
            password: creds.password,
          });
          if (retryErr || !retrySign.user?.id) {
            throw new Error(
              `Admin user ${creds.email} exists but sign-in failed (${retryErr?.message ?? 'no user'}). ` +
                'Set TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD to a working account, or reset the password in Dashboard.',
            );
          }
          userId = retrySign.user.id;
        } else {
          userId = created.user?.id ?? null;
        }
      }

      if (!userId) throw new Error('Admin user id missing after create/sign-in');

      // PostgREST with sb_secret is stable (unlike Auth Admin).
      const { error: upsertErr } = await admin.from('admin_users').upsert(
        { user_id: userId },
        { onConflict: 'user_id' },
      );
      if (upsertErr) throw new Error(`admin_users upsert failed: ${upsertErr.message}`);
    })().catch((err) => {
      ensureAdminUserPromise = null;
      throw err;
    });
  }
  await ensureAdminUserPromise;
  return creds;
}

/** Supabase client signed in as the session admin (for admin_* RPC fallbacks). */
export async function getAdminSessionClient() {
  const { email, password } = await ensureTestAdminUser();
  const client = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`admin session signIn failed: ${error.message}`);
  return client;
}

/** Wait for Settings admin session check (data-admin-auth-checked). */
export async function waitForSettingsAdminReady(page: Page) {
  await page.getByTestId('settings-screen').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="settings-screen"]')
        ?.getAttribute('data-admin-auth-checked') === 'true',
    { timeout: 20000 },
  );
}

/** 7-tap Settings title → reveal Admin tab (no PIN dialog). */
export async function revealAdminTab(page: Page) {
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).toHaveCount(0);

  const title = page.locator('[data-testid="settings-screen"] h1').first();
  await expect(title).toBeVisible({ timeout: 8000 });
  for (let i = 0; i < 7; i += 1) {
    await title.click();
  }

  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('alertdialog').filter({ hasText: /Developer PIN/i })).toHaveCount(0);
}

/**
 * Reveal Admin tab via 7-tap gesture, sign in with TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD,
 * wait for admin-panel. Ensures auth user exists on TEST via service role when needed.
 */
export async function loginAsAdminViaSession(page: Page, deviceId = `admin_device_${Date.now()}`) {
  const { email, password } = await ensureTestAdminUser();

  // Optional device/phone context for audit labels; auth is session-based.
  await page.goto(APP_URL);
  await page.evaluate((id) => {
    localStorage.setItem('aaspaas:device_id', id);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, deviceId);
  await page.goto(`${APP_URL}/settings`);
  await revealAdminTab(page);

  await page.getByTestId('settings-tab-admin').click();
  await expect(page.getByTestId('admin-login-gate')).toBeVisible({ timeout: 8000 });

  await page.locator('#admin-login-email').fill(email);
  await page.locator('#admin-login-password').fill(password);
  await page.getByTestId('admin-login-gate').getByRole('button', { name: /Sign in/i }).click();

  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 15000 });
}

/**
 * @deprecated Prefer loginAsAdminViaSession — phone-based admin gating is gone.
 * Kept as alias so older callers keep compiling until fully migrated.
 */
export async function loginAsAdmin(page: Page, deviceId = `admin_device_${Date.now()}`) {
  await loginAsAdminViaSession(page, deviceId);
}

// Simulate a logged-in vendor
export async function loginAsVendor(
  page: Page,
  phone: string,
  vendorId: string,
  deviceId: string,
  opts?: { skipOnboarding?: boolean },
) {
  const markOnboarded = opts?.skipOnboarding !== false;
  await page.goto(APP_URL);
  await page.evaluate(
    ({ phone, vendorId, deviceId, markOnboarded }) => {
      localStorage.setItem('aaspaas:user_phone', phone);
      localStorage.setItem('aaspaas:device_id', deviceId);
      localStorage.setItem('aaspaas:vendor_id', vendorId);
      localStorage.setItem('aaspaas:role', 'vendor');
      localStorage.setItem('aaspaas:welcomed', 'true');
      if (markOnboarded) {
        localStorage.setItem('aaspaas:vendor_onboarded', 'true');
      } else {
        localStorage.removeItem('aaspaas:vendor_onboarded');
      }
    },
    { phone, vendorId, deviceId, markOnboarded },
  );

  // Phase D: mint a real Supabase session so Phase C RLS policies work
  await mintBrowserSupabaseSession(page, phone, 'loginAsVendor');

  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Avoid networkidle — Realtime WebSocket + Vite HMR never go fully idle.
  await page.waitForSelector('[data-testid="home-screen"]', { timeout: 15000 });
}

// Fresh user — no localStorage at all
export async function loginAsFreshUser(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(APP_URL);
  await page.waitForSelector('[data-testid="first-open-flow"]', { timeout: 15000 });
}

// Clear session
export async function logout(page: Page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/** Vendor Settings → Preferences tab (menu, offers, khata, reviews, etc.). */
export async function openVendorPreferencesTab(page: Page) {
  await page.getByTestId('settings-vendor-tab-preferences').click();
}

/** Vendor Settings → My Business tab (identity, reach, radius, verification). */
export async function openVendorMyBusinessTab(page: Page) {
  await page.getByTestId('settings-vendor-tab-business').click();
  await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 20000 });
}

/**
 * Expand My Business identity accordion (name, phone, selfie).
 * Required since 258776c — all My Business accordions start closed.
 */
export async function expandMyBusinessIdentityAccordion(page: Page) {
  const root = page.getByTestId('vendor-my-business');
  const toggle = root.getByTestId('my-business-identity-accordion-toggle');
  await expect(toggle).toBeVisible({ timeout: 15000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(root.getByTestId('my-business-identity-panel')).toBeVisible({ timeout: 10000 });
}

/**
 * Expand a per-category business accordion (availability, radius, menu/ops).
 * Required since 258776c — all My Business accordions start closed.
 */
export async function expandMyBusinessCategoryAccordion(page: Page, categoryId: string) {
  const root = page.getByTestId('vendor-my-business');
  const toggle = root.getByTestId(`my-business-accordion-toggle-${categoryId}`);
  await expect(toggle).toBeVisible({ timeout: 15000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(root.getByTestId(`my-business-category-settings-${categoryId}`)).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Expand the first per-category accordion when the category id is unknown.
 * Prefer expandMyBusinessCategoryAccordion(categoryId) when available.
 */
export async function expandFirstMyBusinessCategoryAccordion(page: Page) {
  const root = page.getByTestId('vendor-my-business');
  const toggle = root.locator('[data-testid^="my-business-accordion-toggle-"]').first();
  await expect(toggle).toBeVisible({ timeout: 15000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(root.getByTestId('my-business-operations').first()).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Expand the Settings MY ACCOUNT parent accordion.
 * Nested rows (Identity, Account Standing, Preferences, Local Feed) start hidden.
 */
export async function expandMyAccountAccordion(page: Page) {
  const toggle = page.getByTestId('settings-my-account-toggle');
  await expect(toggle).toBeVisible({ timeout: 15000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
