import { defineConfig, devices } from '@playwright/test';

// Browser tests for the phone app (test/browser). They run the real app against a fake agent
// (test/browser/serve.ts). Locally you can use an installed browser instead of downloading one:
//   PW_CHANNEL=msedge npm run test:browser   (or chrome)
export default defineConfig({
  testDir: 'test/browser',
  timeout: 20_000,
  // One fake agent is shared by all tests, so run them one at a time.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: 'http://127.0.0.1:49390',
    channel: process.env.PW_CHANNEL || undefined,
    // A cached app shell would hide changes between tests
    serviceWorkers: 'block',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node --experimental-strip-types test/browser/serve.ts',
    url: 'http://127.0.0.1:49391/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
