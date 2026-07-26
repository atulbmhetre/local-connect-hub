import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from '@playwright/test';
import { getSupabaseUrl, loadTestEnv } from './tests/helpers/testEnv';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Full Playwright suite against PROD (.env.test.prod).
 * Does not change default TEST runs (`playwright.config.ts`).
 *
 * Run:
 *   npx playwright test --config=playwright.prod-full.config.ts
 *
 * Notes:
 * - Sets TEST_ENV=test.prod so helpers/loadTestEnv read .env.test.prod
 * - webServer uses .env.test.prod only (does NOT load .env.playwright — that file
 *   hardcodes the TEST project URL and would silently retarget the app)
 * - Port 8082 avoids colliding with the normal TEST Vite on 8081
 * - No testIgnore: full suite including prod-vendor-wizard-smoke.spec.ts
 * - HARD STOP if VITE_SUPABASE_URL is not PROD
 */
process.env.TEST_ENV = 'test.prod';
dotenv.config({ path: path.join(projectRoot, '.env.local'), override: true });
dotenv.config({ path: path.join(projectRoot, '.env.test.prod'), override: true });
// .env.test.prod historically sets TEST_ENV=test — force the PROD-full selector back.
process.env.TEST_ENV = 'test.prod';
loadTestEnv();
process.env.TEST_ENV = 'test.prod';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const supabaseUrl = getSupabaseUrl();
if (!supabaseUrl.includes(PROD_REF)) {
  throw new Error(
    `playwright.prod-full.config.ts: refusing to start — expected PROD ref ${PROD_REF}, got ${supabaseUrl}`,
  );
}

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
if (browsersPath?.startsWith('.')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(projectRoot, browsersPath);
}

const PREVIEW_PORT = 8082;
const baseURL = process.env.VITE_APP_URL?.includes(String(PREVIEW_PORT))
  ? process.env.VITE_APP_URL.replace(/\/$/, '')
  : `http://127.0.0.1:${PREVIEW_PORT}`;
// Pin before workers import helpers — .env.test.prod still has VITE_APP_URL=:8081.
process.env.PW_APP_URL = baseURL;
process.env.VITE_APP_URL = baseURL;

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  retries: 1,
  workers: 1,
  // Own config/port (playwright.prod-smoke.config.ts on :4173) — do not double-run here.
  testIgnore: ['**/prod-vendor-wizard-smoke.spec.ts'],
  globalSetup: './tests/helpers/prodFullGlobalSetup.ts',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  reporter: [['html', { outputFolder: 'playwright-report-prod-full' }], ['list']],
  webServer: {
    // Intentionally omit .env.playwright (hardcodes TEST URL).
    command: `npx dotenv -e .env.test.prod -- vite --port ${PREVIEW_PORT} --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: process.env.PW_REUSE_PROD_FULL_SERVER === 'true',
    timeout: 120000,
    env: {
      TEST_ENV: 'test.prod',
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL!,
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY!,
      VITE_APP_URL: baseURL,
    },
  },
});
