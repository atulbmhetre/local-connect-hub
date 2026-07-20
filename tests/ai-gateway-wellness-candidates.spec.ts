import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

// Atul's decision: Therapist and Beautician are permanently distinct categories,
// and BOTH must surface as candidates for ambiguous wellness/massage queries so
// the tier sheet (customer choice) does the disambiguation — never the system.
//
// NOTE: this exercises the ranked Groq path in ai-gateway's classify_category.
// If GROQ_API_KEY is missing on the project, the gateway silently degrades to
// the suggest-category single-guess fallback (max 1 candidate) and this fails.

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

test.describe('ai-gateway classify_category — wellness disambiguation', () => {
  test('ACW-01: ambiguous wellness query surfaces BOTH Therapist and Beautician as candidates', async () => {
    const labels = await classify('need a massage');
    console.log('ACW-01 candidates for "need a massage":', JSON.stringify(labels));
    // Order doesn't matter, presence does — the customer picks in the tier sheet.
    expect(labels).toEqual(
      expect.arrayContaining(['Therapist', 'Beautician']),
    );
  });
});
