/**
 * Bill notify i18n: inbox title/body use customer app_users.lang (not vendor device lang).
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import { uniqueTestPhone } from './helpers/session38';

const T = Date.now();

type LangCase = 'hi' | 'mr' | 'en' | 'unset';

const EXPECTED = {
  hi: {
    title: 'विक्रेता से बिल',
    paymentCash: 'नकद',
    bodySuffix: ' — नकद',
  },
  mr: {
    title: 'विक्रेत्याकडून बिल',
    paymentCash: 'रोख',
    bodySuffix: ' — रोख',
  },
  en: {
    title: 'Bill from your vendor',
    paymentCash: 'Cash',
    bodySuffix: ' — Cash',
  },
} as const;

async function seedCustomerLang(phone: string, langCase: LangCase): Promise<void> {
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 70 }, { onConflict: 'phone' });
  await supabaseAdmin.from('app_users').delete().eq('phone', phone);
  if (langCase !== 'unset') {
    const { error } = await supabaseAdmin.from('app_users').upsert(
      { phone, lang: langCase },
      { onConflict: 'phone' },
    );
    expect(error, error?.message).toBeNull();
  }
}

async function insertCashBill(
  vendorId: string,
  customerPhone: string,
  shopName: string,
  amount: number,
): Promise<{ billId: string; requestId: string }> {
  const { data: request, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      message: `bill-i18n-${T}`,
      status: 'accepted',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  await supabaseAdmin.from('vendors').update({ shop_name: shopName }).eq('id', vendorId);

  const { data: billId, error: billErr } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: amount,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'i18n item', quantity: 1, unit_price: amount, unit: null }],
  });
  if (billErr) throw new Error(billErr.message);

  return { billId: billId as string, requestId: request.id as string };
}

async function waitForBillInbox(customerPhone: string, requestId: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { data, error } = await supabaseAdmin
      .from('user_notifications')
      .select('title, body')
      .eq('user_phone', customerPhone)
      .eq('type', 'bill')
      .contains('route_params', { order_id: requestId })
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data?.length === 1) return data[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No bill inbox row for ${customerPhone} / ${requestId}`);
}

test.describe('bill notify i18n (customer lang)', () => {
  let vendor: { id: string; phone: string };
  const shopName = `I18nShop-${T}`;

  test.beforeAll(async () => {
    vendor = await createTestVendor({
      shop_name: shopName,
      service_mode: 'delivery',
    });
  });

  test.afterAll(async () => {
    await cleanupTestVendors();
  });

  for (const langCase of ['hi', 'mr', 'en', 'unset'] as const) {
    test(`BN-I18N-${langCase.toUpperCase()} — inbox title/body match customer lang`, async () => {
      const customer = uniqueTestPhone(`882${langCase === 'unset' ? '99' : langCase === 'hi' ? '01' : langCase === 'mr' ? '02' : '03'}`);
      const amount = langCase === 'hi' ? 240 : langCase === 'mr' ? 260 : 220;
      const expected = EXPECTED[langCase === 'unset' ? 'en' : langCase];

      await seedCustomerLang(customer, langCase);

      const { billId, requestId } = await insertCashBill(vendor.id, customer, shopName, amount);
      const row = await waitForBillInbox(customer, requestId);

      expect(row.title, `title for lang=${langCase}`).toBe(expected.title);
      expect(row.body, `body for lang=${langCase}`).toContain(shopName);
      expect(row.body, `body for lang=${langCase}`).toContain(`₹${amount}`);
      expect(row.body, `body for lang=${langCase}`).toContain(expected.bodySuffix);

      if (langCase === 'hi') {
        expect(row.title).toBe('विक्रेता से बिल');
        expect(row.body).toBe(`${shopName}: ₹${amount} — नकद`);
        expect(row.body).not.toContain(' — Cash');
      }
      if (langCase === 'mr') {
        expect(row.title).toBe('विक्रेत्याकडून बिल');
        expect(row.body).toBe(`${shopName}: ₹${amount} — रोख`);
        expect(row.body).not.toContain(' — Cash');
      }
      if (langCase === 'en' || langCase === 'unset') {
        expect(row.title).toBe('Bill from your vendor');
        expect(row.body).toBe(`${shopName}: ₹${amount} — Cash`);
      }

      test.info().annotations.push({
        type: 'observed',
        description: `lang=${langCase} title="${row.title}" body="${row.body}"`,
      });

      await supabaseAdmin.from('order_items').delete().eq('bill_id', billId);
      await supabaseAdmin.from('order_bills').delete().eq('id', billId);
      await supabaseAdmin.from('user_notifications').delete().eq('user_phone', customer);
      await supabaseAdmin.from('requests').delete().eq('id', requestId);
      await supabaseAdmin.from('app_users').delete().eq('phone', customer);
      await supabaseAdmin.from('users').delete().eq('phone', customer);
    });
  }
});
