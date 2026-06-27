import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

const env = process.env.TEST_ENV || 'test';
dotenv.config({ path: `.env.${env}` });

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  retries: 1,
  workers: 1,
  use: {
    baseURL: process.env.VITE_APP_URL || 'http://localhost:8081',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],
  webServer: {
    command: 'npx dotenv -e .env.playwright -- vite --port 8081',
    port: 8081,
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      VITE_SUPABASE_URL: 'https://hhdylnhqdzfabsolwxdz.supabase.co',
      VITE_SUPABASE_ANON_KEY:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoZHlsbmhxZHpmYWJzb2x3eGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDQ0ODEsImV4cCI6MjA5NjAyMDQ4MX0.CWGB3IcOmFK7NsHIy6bgPulRfVGRuDxXDzdEZ7V777s',
    },
  },
});
