import { defineConfig, devices } from '@playwright/test';

// E2E harness for the admin SPA. Tests run a real Chromium with ALL /api/v1
// calls mocked (see e2e/support.js), so they exercise the real page-level flows
// (routing, modals, actions) without a backend or DB.
//
// Against a PRODUCTION BUILD, not the dev server. The dev server compiles
// modules on demand, so the first navigation to each route pays for that
// compile, and under load it pays a great deal: one run of this suite took
// 29.7 minutes against `vite dev` where others took four, and the failures it
// produced were assertion timeouts on different tests each time rather than
// anything to do with the code. A suite whose failures track wall time cannot
// answer the only question it exists for.
//
// The build is also what actually ships, which is the better thing to test.
// Set E2E_DEV=1 to point at a running dev server instead, which is what you
// want while writing a test rather than running the suite.
const DEV = process.env.E2E_DEV === '1';
// Deliberately not 5173: a dev server left running must never be picked up in
// place of the build, which is the kind of thing that makes a suite pass
// locally and fail everywhere else.
const PREVIEW_PORT = 4317;

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
    baseURL: DEV ? 'http://localhost:5173' : `http://localhost:${PREVIEW_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: DEV ? {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  } : {
    // Built fresh every run, and `reuseExistingServer` off for the same
    // reason: a suite that silently tests last week's bundle is worse than no
    // suite at all.
    command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
