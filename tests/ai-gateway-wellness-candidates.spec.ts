import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

// Therapist catalog category was removed. Ambiguous wellness/massage queries
// should surface Beautician (static aliases still map therapist/massage → Beautician).

const GATEWAY_URL = `${process.env.VITE_SUPABASE_URL}/functions/v1/ai-gateway`;

async function classify(term: string): Promise<string[]> {
  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: 'classify_category', term }),
  });
  expect(resp.status).toBe(200);
  const data = (await resp.json()) as {
    result?: { candidates?: Array<{ label?: string }> };
  };
  return (data.result?.candidates ?? [])
    .map((c) => c.label ?? '')
    .filter(Boolean);
}

test.describe('ai-gateway classify_category — wellness', () => {
  test('ACW-01: ambiguous wellness query surfaces Beautician (Therapist removed)', async () => {
    const labels = await classify('need a massage');
    console.log('ACW-01 candidates for "need a massage":', JSON.stringify(labels));
    expect(labels).toContain('Beautician');
    expect(labels).not.toContain('Therapist');
  });
});
