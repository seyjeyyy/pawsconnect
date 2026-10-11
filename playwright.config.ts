import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['iPad Mini'], defaultBrowserType:'chromium' } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: 'node tests/helpers/start-e2e.mjs', url: 'http://localhost:4173', reuseExistingServer: false, timeout: 120_000 },
});
