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
  workers: 1,
  // Prod-only specs: run via playwright.prod-smoke / playwright.prod-full configs.
  testIgnore: [
    '**/prod-vendor-wizard-smoke.spec.ts',
    '**/prod-full-connect.spec.ts',
    '**/prod-payment-hygiene-spotcheck.spec.ts',
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
      VITE_ENVIRONMENT: 'test',
    },
  },
});
