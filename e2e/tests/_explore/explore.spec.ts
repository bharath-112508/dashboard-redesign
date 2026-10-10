import { test } from '@playwright/test'
import { signIn } from '../helpers/session'
import * as fs from 'fs'

const out = '/tmp/claude-0/-home-claude-repo/b81f1455-4f25-5d8f-b569-8f58d58e9109/scratchpad/explore'

test('cadmin', async ({ page }) => {
  fs.mkdirSync(out, { recursive: true })
  await signIn(page, 'cadmin')
  await page.waitForTimeout(1500)
  await page.goto('/clients')
  await page.waitForTimeout(1500)
  fs.writeFileSync(out + '/cadmin-home.txt', await page.locator('main').ariaSnapshot())
  await page.goto('/clients/board')
  await page.waitForTimeout(1500)
  fs.writeFileSync(out + '/cadmin-board.txt', await page.locator('main').ariaSnapshot())
  await page.screenshot({ path: out + '/cadmin-board.png', fullPage: true })
  await page.goto('/clients')
  await page.waitForTimeout(800)
  await page.screenshot({ path: out + '/cadmin-home.png', fullPage: true })
})

test('cuser', async ({ page }) => {
  await signIn(page, 'cuser')
  await page.waitForTimeout(1500)
  await page.goto('/clients')
  await page.waitForTimeout(1500)
  fs.writeFileSync(out + '/cuser-home.txt', await page.locator('main').ariaSnapshot())
  await page.goto('/clients/board')
  await page.waitForTimeout(1500)
  fs.writeFileSync(out + '/cuser-board.txt', await page.locator('main').ariaSnapshot())
})
