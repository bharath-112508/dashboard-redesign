import { test, expect } from '@playwright/test'
import { signIn } from './helpers/session'

test('login page renders', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('body')).toContainText(/sign|password/i)
})

test('super admin signs in and reaches the dashboard', async ({ page }) => {
  await signIn(page, 'super')
  await expect(page).toHaveURL(/\/dashboard/)
})
