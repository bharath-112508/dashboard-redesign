import { expect, type Page } from '@playwright/test'
import { signIn } from './session'

const DB_KEY = 'vt.clients.db'

/**
 * The app writes its seeded db to localStorage on the first write, not on load.
 * This logs a time entry as a developer and removes it, so the db exists before a
 * test edits it. Leaves the browser signed in as that developer.
 */
export async function primeStore(page: Page) {
  await signIn(page, 'dev')
  await logTextEntry(page, 'Store setup', '')
  await waitForStored(page, 'Store setup', true)
  await page.getByRole('button', { name: 'Remove Store setup' }).click()
  await waitForStored(page, 'Store setup', false)
}

/**
 * Sets a ticket's due date in the stored db, then reloads so the page reads it.
 * Used to create overdue tickets, since the seed has none open. Needs primeStore first.
 */
export async function setTaskDue(page: Page, taskId: string, due: string) {
  await page.evaluate(
    ([key, id, d]) => {
      const db = JSON.parse(localStorage.getItem(key) as string)
      const task = db.tasks.find((t: { id: string }) => t.id === id)
      if (!task) throw new Error(`no task ${id}`)
      task.due = d
      localStorage.setItem(key, JSON.stringify(db))
    },
    [DB_KEY, taskId, due] as const,
  )
  await page.reload()
}

/** Waits until the stored db does (or does not) contain `text`, so a reload reads the saved state. */
export async function waitForStored(page: Page, text: string, present: boolean) {
  await expect
    .poll(() => page.evaluate(([k, t]) => (localStorage.getItem(k) ?? '').includes(t), [DB_KEY, text] as const))
    .toBe(present)
}

/** The billable or non-billable duration button on the log form. */
export const durationButton = (page: Page, label: 'Billable' | 'Non-billable') =>
  page.getByRole('button', { name: `${label} duration`, exact: true })

/** Opens the Log against ticket picker and chooses a ticket by its key. */
export async function pickTicket(page: Page, key: string) {
  await page.getByRole('button', { name: 'Choose a ticket' }).click()
  await page.getByRole('option', { name: new RegExp(`^${key}\\b`) }).click()
}

/** Sets a billable or non-billable duration through the hours and minutes pickers, then closes it. */
export async function setDuration(page: Page, label: 'Billable' | 'Non-billable', hours: number, minutes: number) {
  await durationButton(page, label).click()
  const dialog = page.getByRole('dialog', { name: `${label} duration`, exact: true })
  await dialog.getByRole('button', { name: `${hours}h`, exact: true }).click()
  await dialog.getByRole('button', { name: `${minutes}m`, exact: true }).click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

/** Logs a text entry (one hour billable) from the dashboard form and saves it. */
export async function logTextEntry(page: Page, area: string, notes: string) {
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Area worked on').fill(area)
  await page.getByPlaceholder('What did you do?').fill(notes)
  await setDuration(page, 'Billable', 1, 0)
  await page.getByRole('button', { name: 'Save time entry' }).click()
}
