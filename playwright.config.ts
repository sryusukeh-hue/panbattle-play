import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { channel: process.env.PAN_BROWSER_CHANNEL || undefined, baseURL: 'http://127.0.0.1:4183/panbattle-play/', viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4183 --strictPort', url: 'http://127.0.0.1:4183/panbattle-play/', reuseExistingServer: !process.env.CI },
});
