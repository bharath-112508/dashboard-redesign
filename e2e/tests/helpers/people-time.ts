import type { Locator, Page } from '@playwright/test'

/** A 1x1 PNG, used for profile photo uploads. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** Escapes a string for use inside a RegExp. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Selects the option with exactly this label and returns its value. */
export async function selectByLabel(select: Locator, label: string) {
  await select.selectOption({ label })
}

/** Project column text of every row in the entries table on the Timesheets or History views. */
export async function tableCells(table: Locator, column: number): Promise<string[]> {
  const rows = table.getByRole('row').filter({ has: table.page().getByRole('cell') })
  const count = await rows.count()
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push((await rows.nth(i).getByRole('cell').nth(column).innerText()).trim())
  }
  return out
}

/** Opens the Users page as a given page. */
export async function gotoUsers(page: Page, query = '') {
  await page.goto(`/users${query}`)
}

/** Shared check: the Users table exists and shows the given rows. */
export const usersTable = (page: Page) => page.getByRole('table', { name: 'Users' })

/** Reads the shared store as the app saved it in this browser (localStorage). */
export async function storedDb(page: Page): Promise<{
  entries: { notes: string; area?: string | null }[]
  weekSubmissions: { userId: number; week: string }[]
  people: { id: number; name: string; email: string; active: boolean; invited?: boolean; role: string }[]
  leave: { status: string; userId: number }[]
  notifications?: unknown[]
}> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}'))
}
