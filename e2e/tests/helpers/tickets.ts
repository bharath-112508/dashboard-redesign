import { expect, type Page } from '@playwright/test'

/** A title that cannot collide with seeded data or with other runs of the same test. */
export const uniq = (label: string) => `${label} ${Date.now().toString(36)}`

/** Opens a Tickets tab and waits until the page has loaded its data. */
export async function openTickets(page: Page, view = 'board') {
  await page.goto(`/tickets/${view}`)
  await expect(page.locator('main[data-page="tickets"]')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Board', exact: true })).toBeVisible()
}

/** The title field of the ticket drawer (open whenever a ticket is shown). */
export const drawerTitle = (page: Page) => page.getByPlaceholder('Ticket title')

/** Closes the ticket drawer with Escape and waits for it to go. */
export async function closeDrawer(page: Page) {
  await page.keyboard.press('Escape')
  await expect(drawerTitle(page)).toHaveCount(0)
}

/** A details-sidebar row of the drawer, by its label (Priority, Type, Epic, Sprint …). */
export function detailPill(page: Page, label: string) {
  return page.locator('div.min-h-\\[46px\\]').filter({ has: page.locator(`span:text-is("${label}")`) }).getByRole('button').first()
}

/** An option of the open pill menu. */
export function pillOption(page: Page, label: string) {
  return page.locator('[class*="z-[51]"]').getByRole('button', { name: new RegExp('^' + label) }).first()
}

/** The drawer's Activity tab text (comments and history), used to check logged changes. */
export async function openActivity(page: Page) {
  await page.getByRole('button', { name: /^Activity/ }).click()
}

/**
 * Waits until the saved store holds `text`. Writes are applied after a short delay, so
 * a reload before this would race the save. Use only with plain ASCII text.
 */
export async function expectSaved(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => {
      try {
        return localStorage.getItem('vt.clients.db') ?? ''
      } catch {
        return ''
      }
    }), { timeout: 8_000, message: `"${text}" was not saved to the store` })
    .toContain(text)
}

/** The board column with this status name. */
export const column = (page: Page, name: string) => page.locator(`[data-col="${name}"]`)

/** Waits until the saved store no longer holds `text`. */
export async function expectNotSaved(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => {
      try {
        return localStorage.getItem('vt.clients.db') ?? ''
      } catch {
        return ''
      }
    }), { timeout: 8_000, message: `"${text}" is still in the store` })
    .not.toContain(text)
}

/** The open pop-up menu of a board or epic picker (Epic, Sprint). */
export const menu = (page: Page) => page.locator('[class*="z-[41]"]').first()

/**
 * Opens the sprint window of a sprint card by its state label (Active, Planned, Done).
 * `which` picks among several matches; 'last' is the newest sprint of the open epic.
 */
export async function openSprintWindow(page: Page, state: string, which: 'first' | 'last' = 'first') {
  const cards = page.getByRole('button', { name: new RegExp(`, ${state}$`) })
  const card = which === 'last' ? cards.last() : cards.first()
  await card.getByTitle('Sprint overview').click()
}
