/**
 * One-shot realtime publication probe for public.requests.
 *
 *   PHASE=before REALTIME_PROBE_MODE=otp-off REALTIME_PROBE_EXPECT=no-update npx playwright test tests/realtime-requests-probe.spec.ts
 *   PHASE=after  REALTIME_PROBE_MODE=auth    REALTIME_PROBE_EXPECT=update    npx playwright test tests/realtime-requests-probe.spec.ts
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { loginAsCustomer, mintBrowserSupabaseSession } from './helpers/setup';

const MODE = (process.env.REALTIME_PROBE_MODE || 'otp-off') as 'otp-off' | 'auth';
const EXPECT = (process.env.REALTIME_PROBE_EXPECT || 'no-update') as 'update' | 'no-update';
const PHASE = process.env.PHASE || 'unknown';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PHONE = `8807${String(Date.now()).slice(-6)}`.slice(0, 10);
const VENDOR_PHONE = `9907${String(Date.now()).slice(-6)}`.slice(0, 10);
const TAG = `rt-req-probe-${Date.now()}`;
const SHOP = `RT Probe ${TAG}`;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(() => {
  test.skip(
    !process.env.PHASE,
    'Set PHASE / REALTIME_PROBE_* to run this one-shot probe (ignored in normal suite)',
  );
});

test(`requests realtime probe [${PHASE}] mode=${MODE} expect=${EXPECT}`, async ({ page }) => {
  let vendorId: string | null = null;
  let categoryId: string | null = null;
  let requestId: string | null = null;
  const results: Record<string, unknown>[] = [];

  try {
    const { data: cat, error: catErr } = await admin.from('categories').select('id').limit(1).single();
    if (catErr) throw catErr;
    categoryId = cat.id;

    const { data: vendor, error: ve } = await admin
      .from('vendors')
      .insert({
        name: TAG,
        shop_name: SHOP,
        phone: VENDOR_PHONE,
        discoverable: true,
        is_active: true,
        profile_status: 'complete',
        service_mode: 'help',
      })
      .select('id')
      .single();
    if (ve) throw ve;
    vendorId = vendor.id;

    await admin.from('vendor_categories').upsert({
      vendor_id: vendorId,
      category_id: categoryId,
      service_mode: 'help',
    });

    const { data: req, error: re } = await admin
      .from('requests')
      .insert({
        vendor_id: vendorId,
        user_phone: PHONE,
        message: TAG,
        status: 'accepted',
        service_mode: 'help',
        device_id: 'rt-probe-device',
      })
      .select('id')
      .single();
    if (re) throw re;
    requestId = req.id;

    // ── Home banner ─────────────────────────────────────────────────────────
    if (MODE === 'auth') {
      await loginAsCustomer(page, PHONE, 'rt-probe-device');
      const sessionPhone = await page.evaluate(async () => {
        const w = window as unknown as {
          __AASPAAS_TEST_AUTH__?: { supabaseUrl: string };
        };
        // Use the app's supabase client via dynamic import path is unavailable;
        // read auth storage for a session token presence instead.
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (!keys.length) return null;
        try {
          const raw = localStorage.getItem(keys[0]);
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed?.user?.phone ?? parsed?.currentSession?.user?.phone ?? 'present';
        } catch {
          return null;
        }
      });
      expect(sessionPhone, 'auth session must exist for auth-mode probe').toBeTruthy();
      console.log('SESSION_PHONE', sessionPhone);
    } else {
      await page.goto('/');
      await page.evaluate((phone) => {
        localStorage.setItem('aaspaas:welcomed', 'true');
        localStorage.setItem('aaspaas:user_phone', phone);
        localStorage.setItem('aaspaas:device_id', 'rt-probe-device');
        localStorage.setItem('aaspaas:role', 'customer');
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('sb-') && k.includes('auth')) localStorage.removeItem(k);
        }
      }, PHONE);
      await page.reload();
    }

    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 20_000 });
    const bannerShop = page.getByText(SHOP, { exact: false }).first();
    await expect(bannerShop).toBeVisible({ timeout: 25_000 });

    // In-page authenticated subscriber (isolates publication/RLS from Index hydrate race).
    const listenerReady = await page.evaluate(
      async ({ url, anonKey, phone }) => {
        const mod = await import('https://esm.sh/@supabase/supabase-js@2.49.1');
        const client = mod.createClient(url, anonKey, { auth: { persistSession: true } });
        // Reuse existing session from localStorage (same project).
        const { data: sess } = await client.auth.getSession();
        (window as unknown as { __RT_PROBE?: { events: unknown[]; sessionPhone: string | null } }).__RT_PROBE = {
          events: [],
          sessionPhone: sess.session?.user?.phone ?? null,
        };
        await new Promise<void>((resolve) => {
          const ch = client
            .channel(`inpage-probe-${Date.now()}`)
            .on(
              'postgres_changes',
              {
                event: 'UPDATE',
                schema: 'public',
                table: 'requests',
                filter: `user_phone=eq.${phone}`,
              },
              (payload) => {
                (window as unknown as { __RT_PROBE: { events: unknown[] } }).__RT_PROBE.events.push(
                  payload.new,
                );
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') resolve();
            });
          setTimeout(() => resolve(), 8000);
        });
        return {
          sessionPhone: sess.session?.user?.phone ?? null,
          hasSession: !!sess.session,
        };
      },
      {
        url: SUPABASE_URL,
        anonKey: process.env.VITE_SUPABASE_ANON_KEY!,
        phone: PHONE,
      },
    );
    console.log('INPAGE_LISTENER', JSON.stringify(listenerReady));
    await page.waitForTimeout(1000);

    const t0 = Date.now();
    expect((await admin.from('requests').update({ status: 'cancelled' }).eq('id', requestId)).error).toBeNull();

    const inpageGot = await page
      .waitForFunction(() => ((window as unknown as { __RT_PROBE?: { events: unknown[] } }).__RT_PROBE?.events?.length ?? 0) > 0, null, {
        timeout: 8_000,
      })
      .then(() => true)
      .catch(() => false);

    const homeGone = await bannerShop
      .waitFor({ state: 'hidden', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    const homeResult = {
      phase: PHASE,
      mode: MODE,
      surface: 'home_banner',
      expect: EXPECT,
      updated_fast: homeGone,
      inpage_event: inpageGot,
      listener_has_session: listenerReady.hasSession,
      elapsed_ms: Date.now() - t0,
      requestId,
    };
    results.push(homeResult);
    console.log('PROBE_RESULT', JSON.stringify(homeResult));
    if (EXPECT === 'update') {
      // Publication+RLS proof: in-page authed subscriber must see the event.
      expect(inpageGot, 'in-page authed realtime event').toBe(true);
      // UI may still lag if Index subscribed before auth hydrated — report separately.
    } else {
      expect(homeGone).toBe(false);
      expect(inpageGot).toBe(false);
    }

    // ── MyOrders ────────────────────────────────────────────────────────────
    await admin.from('requests').update({ status: 'accepted' }).eq('id', requestId);
    await page.goto('/my-orders');
    await page.waitForTimeout(2500);
    const orderText = page.getByText(TAG).first();
    await expect(orderText).toBeVisible({ timeout: 25_000 });

    const t1 = Date.now();
    await admin.from('requests').update({ status: 'cancelled' }).eq('id', requestId);
    const moChanged = await page
      .waitForFunction(
        (tag) => {
          const t = document.body?.innerText || '';
          return /cancel/i.test(t) || !t.includes(tag);
        },
        TAG,
        { timeout: 8_000 },
      )
      .then(() => true)
      .catch(() => false);
    const moResult = {
      phase: PHASE,
      mode: MODE,
      surface: 'my_orders',
      expect: EXPECT,
      updated_fast: moChanged,
      elapsed_ms: Date.now() - t1,
    };
    results.push(moResult);
    console.log('PROBE_RESULT', JSON.stringify(moResult));
    if (EXPECT === 'update') expect(moChanged).toBe(true);
    else expect(moChanged).toBe(false);

    // ── IncomingOrders (vendor) ─────────────────────────────────────────────
    await admin.from('requests').update({ status: 'sent' }).eq('id', requestId);

    await page.goto('/');
    await page.evaluate(
      ({ vendorPhone, vid, clearAuth }) => {
        localStorage.setItem('aaspaas:welcomed', 'true');
        localStorage.setItem('aaspaas:user_phone', vendorPhone);
        localStorage.setItem('aaspaas:device_id', 'rt-probe-vendor-device');
        localStorage.setItem('aaspaas:role', 'vendor');
        localStorage.setItem('aaspaas:vendor_id', vid);
        localStorage.setItem('aaspaas:vendor_active', 'true');
        if (clearAuth) {
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith('sb-') && k.includes('auth')) localStorage.removeItem(k);
          }
        }
      },
      { vendorPhone: VENDOR_PHONE, vid: vendorId, clearAuth: MODE === 'otp-off' },
    );
    if (MODE === 'auth') {
      await mintBrowserSupabaseSession(page, VENDOR_PHONE, 'rt-probe-vendor');
    }
    await page.goto('/vendor');
    await page.waitForTimeout(3000);

    const incoming = page.getByText(TAG).first();
    const incomingVisible = await incoming.isVisible().catch(() => false);

    if (!incomingVisible) {
      const skip = {
        phase: PHASE,
        mode: MODE,
        surface: 'incoming_orders',
        skipped: true,
        reason: 'probe order not visible in vendor incoming UI',
      };
      results.push(skip);
      console.log('PROBE_RESULT', JSON.stringify(skip));
    } else {
      const t2 = Date.now();
      await admin.from('requests').update({ status: 'cancelled' }).eq('id', requestId);
      const incomingGone = await incoming
        .waitFor({ state: 'hidden', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      const inResult = {
        phase: PHASE,
        mode: MODE,
        surface: 'incoming_orders',
        expect: EXPECT,
        updated_fast: incomingGone,
        elapsed_ms: Date.now() - t2,
      };
      results.push(inResult);
      console.log('PROBE_RESULT', JSON.stringify(inResult));
      if (EXPECT === 'update') expect(incomingGone).toBe(true);
      else expect(incomingGone).toBe(false);
    }
  } finally {
    if (requestId) await admin.from('requests').delete().eq('id', requestId);
    if (vendorId) {
      await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
      await admin.from('vendors').delete().eq('id', vendorId);
    }
    console.log('PROBE_SUMMARY', JSON.stringify(results));
  }
});
