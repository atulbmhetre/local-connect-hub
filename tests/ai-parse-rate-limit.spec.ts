import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

// AI parsing edge functions (parse-voice-bill, parse-image-bill) are anon-
// reachable and call paid AI APIs. They are now metered via
// check_and_log_rate_limit: 10/min per phone (when supplied) + 20/min per IP.
//
// The blocked path is exercised by pre-seeding the phone bucket to its limit —
// no AI credits are consumed. The allowed path is proven by sending a request
// that passes rate limiting but fails input validation ("Missing text" /
// "Missing image_base64"), which also never reaches the AI API.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;
const PHONE_LIMIT = 10;

const T = Date.now();

function fnUrl(name: string): string {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

async function callFn(name: string, body: Record<string, unknown>) {
  const resp = await fetch(fnUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

async function exhaustPhoneBucket(functionName: string, phone: string) {
  const rows = Array.from({ length: PHONE_LIMIT }, () => ({
    function_name: functionName,
    identifier_type: 'phone',
    identifier: phone,
  }));
  const { error } = await supabaseAdmin.from('edge_function_rate_limits').insert(rows);
  if (error) throw error;
}

async function clearPhoneBucket(functionName: string, phone: string) {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', functionName)
    .eq('identifier', phone);
}

test('AIRL-01: parse-voice-bill allows a request under the limit (reaches validation, no AI call)', async () => {
  const phone = `99051${String(T).slice(-5)}`;
  try {
    const { status, json } = await callFn('parse-voice-bill', { text: '', phone });
    expect(status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Missing text');
  } finally {
    await clearPhoneBucket('parse-voice-bill', phone);
  }
});

test('AIRL-02: parse-voice-bill rejects with 429 once the phone bucket is exhausted', async () => {
  const phone = `99052${String(T).slice(-5)}`;
  await exhaustPhoneBucket('parse-voice-bill', phone);
  try {
    const { status, json } = await callFn('parse-voice-bill', {
      text: '2kg onion 40 rupees',
      phone,
    });
    expect(status).toBe(429);
    expect(json.success).toBe(false);
    expect(String(json.error)).toMatch(/too many requests/i);
  } finally {
    await clearPhoneBucket('parse-voice-bill', phone);
  }
});

test('AIRL-03: parse-image-bill allows a request under the limit (reaches validation, no AI call)', async () => {
  const phone = `99053${String(T).slice(-5)}`;
  try {
    const { status, json } = await callFn('parse-image-bill', { image_base64: '', phone });
    expect(status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Missing image_base64');
  } finally {
    await clearPhoneBucket('parse-image-bill', phone);
  }
});

test('AIRL-04: parse-image-bill rejects with 429 once the phone bucket is exhausted', async () => {
  const phone = `99054${String(T).slice(-5)}`;
  await exhaustPhoneBucket('parse-image-bill', phone);
  try {
    const { status, json } = await callFn('parse-image-bill', {
      image_base64: 'aGVsbG8=',
      media_type: 'image/png',
      phone,
    });
    expect(status).toBe(429);
    expect(json.success).toBe(false);
    expect(String(json.error)).toMatch(/too many requests/i);
  } finally {
    await clearPhoneBucket('parse-image-bill', phone);
  }
});

test('AIRL-05: parse-image-bill healthCheck stays exempt from rate limiting', async () => {
  const { status, json } = await callFn('parse-image-bill', { healthCheck: true });
  expect(status).toBe(200);
  expect(json.status).toBe('ok');
});
