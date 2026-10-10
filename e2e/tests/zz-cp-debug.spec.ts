import { test } from '@playwright/test'
import { signIn } from './helpers/session'
test('debug area', async ({ page }) => {
  await signIn(page, 'super')
  await page.goto('/projects')
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Start a new project' })
  await dialog.getByRole('radio', { name: /Internal project/ }).click()
  await page.waitForTimeout(800)
  const info = await dialog.locator('select').evaluateAll(els => els.map(e => ({ label: (e.closest('label')?.textContent ?? ''), opts: [...e.querySelectorAll('option')].map(o => o.textContent) })))
  console.log('INFO ' + JSON.stringify(info))
})
