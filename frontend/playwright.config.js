import { defineConfig, devices } from '@playwright/test';

// E2E harness for the admin SPA. Tests run a real Chromium against the Vite dev
// server with ALL /api/v1 calls mocked (see e2e/support.js) , so they exercise the
// real page-level flows (routing, modals, actions) without a backend or DB.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // 7s was too tight for the tail of a 124-test run: two checks that pass
  // 6/6 in isolation failed only in the full suite, both on an assertion
  // timeout rather than a wrong value. Retries are deliberately left at 0:
  // waiting longer for the right answer is not the same as accepting a
  // second opinion, and a genuinely broken popover still never appears.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
