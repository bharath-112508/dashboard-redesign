import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end suite for the Viljetech app. Runs against a running dev server
 * (or preview build) at E2E_BASE_URL. The app keeps its data in the browser
 * (localStorage), so every test starts from a fresh, seeded browser context.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    // The sandbox's pre-installed Chromium; set E2E_CHROMIUM to override.
    launchOptions: { executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
