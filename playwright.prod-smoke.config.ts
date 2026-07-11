import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(projectRoot, '.env.test.prod'), override: true });

const previewUrl = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests',
  testMatch: 'prod-vendor-wizard-smoke.spec.ts',
  timeout: 90000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: previewUrl,
    headless: true,
  },
  reporter: [['list']],
});
