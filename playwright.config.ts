import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-results',
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'msedge', headless: true, viewport: { width: 1180, height: 870 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npm.cmd run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 30000 },
});
