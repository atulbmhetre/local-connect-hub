import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { loadTestEnv } from './tests/helpers/testEnv';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

function loadEnvAndResolveBrowsersPath(): void {
  loadTestEnv();

  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (browsersPath?.startsWith('.')) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(projectRoot, browsersPath);
  }
}

loadEnvAndResolveBrowsersPath();

// Node 24 + Windows: libuv UV_HANDLE_CLOSING on process.exit after fetch
// (nodejs/node#56645). Playwright CLI update-check fetch is one trigger
// (microsoft/playwright#42402). Disable it; keep a single worker.
process.env.NO_UPDATE_NOTIFIER = process.env.NO_UPDATE_NOTIFIER || '1';

const defaultBaseURL = (process.env.VITE_APP_URL || 'http://localhost:8081').replace(/\/$/, '');
process.env.PW_APP_URL = process.env.PW_APP_URL || defaultBaseURL;
process.env.VITE_APP_URL = defaultBaseURL;

export default defineConfig({
  globalSetup: './tests/globalSetup.ts',
  testDir: './tests',
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  retries: 1,
  // Explicit 1: Node 24 Windows libuv crash (UV_HANDLE_CLOSING) is worse
  // with parallel workers tearing down fetch handles. Do not raise this
  // until this machine is on Node 22 LTS (or a Node 24 build with #61999).
  workers: 1,
  fullyParallel: false,
  // Prod-only specs: run via playwright.prod-smoke / playwright.prod-full configs.
  testIgnore: [
    '**/prod-vendor-wizard-smoke.spec.ts',
    '**/prod-full-connect.spec.ts',
    '**/prod-payment-hygiene-spotcheck.spec.ts',
    '**/prod-device-ux-fixes.spec.ts',
    '**/prod-settings-feed-phone.spec.ts',
  ],
  use: {
    baseURL: process.env.PW_APP_URL || defaultBaseURL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],
  webServer: {
    command: 'npx dotenv -e .env.test -e .env.playwright -- vite --port 8081',
    port: 8081,
    // Default false: a reused dev server often lacks VITE_SUPABASE_URL and falls back to PROD in supabase.ts.
    // Set PW_REUSE_DEV_SERVER=true only when your local Vite on :8081 already loads .env.test.
    reuseExistingServer: process.env.PW_REUSE_DEV_SERVER === 'true',
    timeout: 60000,
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL!,
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY!,
      VITE_OTP_ENABLED: process.env.VITE_OTP_ENABLED ?? 'true',
      VITE_ENVIRONMENT: 'test',
      VITE_FIREBASE_API_KEY: process.env.VITE_FIREBASE_API_KEY ?? '',
      VITE_FIREBASE_AUTH_DOMAIN: process.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
      VITE_FIREBASE_PROJECT_ID: process.env.VITE_FIREBASE_PROJECT_ID ?? '',
      VITE_FIREBASE_STORAGE_BUCKET: process.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
      VITE_FIREBASE_MESSAGING_SENDER_ID: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
      VITE_FIREBASE_APP_ID: process.env.VITE_FIREBASE_APP_ID ?? '',
      VITE_FIREBASE_VAPID_KEY: process.env.VITE_FIREBASE_VAPID_KEY ?? '',
    },
  },
});
