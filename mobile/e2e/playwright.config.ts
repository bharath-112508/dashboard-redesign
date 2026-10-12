import { defineConfig, devices } from '@playwright/test';

/**
 * Viljetech mobile e2e (web build via react-native-web, iPhone-sized viewport).
 * The app keeps its data in AsyncStorage (localStorage on web), so every test starts
 * from a fresh browser context with the seed data.
 *
 * Base URL: MOBILE_BASE_URL (default http://localhost:8091). When nothing listens
 * there, Playwright starts `npx expo start --web` on that port. Always run with a
 * private output folder: `npx playwright test --output=<folder>`.
 */
const baseURL = process.env.MOBILE_BASE_URL ?? 'http://localhost:8091';
const port = new URL(baseURL).port || '80';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  projects: [
    {
      name: 'mobile-web',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: false },
    },
  ],
  webServer: {
    command: `npx expo start --web --port ${port}`,
    cwd: '..',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { CI: '1' },
  },
});
