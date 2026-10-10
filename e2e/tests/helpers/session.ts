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
