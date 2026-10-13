import type { Page } from '@playwright/test'

/** Sample accounts from the people directory (api/people/seed.ts). Password for all of them is `demo`. */
export const USERS = {
  super: 'rahul@viljetech.com', // Rahul, super admin
  admin: 'vivek@viljetech.com', // Vivek, admin
  pm: 'bhavana@viljetech.com', // Bhavana P, project manager
  dev: 'chary@viljetech.com', // Chary, developer
  devops: 'arjun@viljetech.com', // Arjun, DevOps
  cadmin: 'ingrid@daco.no', // Ingrid Solberg, client admin (DACO)
  cuser: 'lars@daco.no', // Lars Moen, client user (DACO)
} as const

export type Role = keyof typeof USERS

/**
 * Signs in through the real login form. Each test runs in a fresh browser
 * context, so the store is seeded on the first load.
 */
export async function signIn(page: Page, role: Role) {
  await page.goto('/login')
  await page.getByPlaceholder('name@company.com').fill(USERS[role])
  await page.getByPlaceholder('••••••••').fill('demo')
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'))
}

/**
 * Sends one command straight to the app's mock backend (`server.send` in
 * src/api/server.ts), skipping the UI, as the signed-in person. The dev server
 * serves the module at its source path, so the page's own instance is used.
 * Resolves with the refusal message when the backend refuses the command.
 */
export async function sendCommand(page: Page, cmd: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  // A string, so the test transpiler leaves the browser's dynamic import alone.
  return page.evaluate(`(async cmd => {
    const { server } = await import('/src/api/server.ts')
    try {
      await server.send(cmd)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  })(${JSON.stringify(cmd)})`) as Promise<{ ok: true } | { ok: false; error: string }>
}
