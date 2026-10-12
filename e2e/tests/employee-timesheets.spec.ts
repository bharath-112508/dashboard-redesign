import { test, expect, type Page } from '@playwright/test'
import { signIn } from './helpers/session'
import { escapeRe, tableCells } from './helpers/people-time'

/** Permission ids a role has in the stored db (the mock backend commits after a short delay). */
const storedPerms = (page: Page, role: string) =>
  page.evaluate(r => {
    const db = JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}')
    return (db.access?.perms?.[r] ?? null) as string[] | null
  }, role)

const entriesHeading = (page: Page) => page.getByRole('heading', { name: /^Entries/ })
const entriesTable = (page: Page) => page.getByRole('table', { name: 'Time entries' })
const entryRows = (page: Page) => entriesTable(page).getByRole('row').filter({ has: page.getByRole('cell') })

async function openEmployeeTimesheets(page: Page, query = '') {
  await signIn(page, 'super')
  await page.goto(`/employee-timesheets${query}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Employee timesheets' })).toBeVisible()
}

/** Opens the employee profile for a name from the Users tab. */
async function openProfile(page: Page, name: string) {
  await page.goto('/employee-timesheets?tab=users')
  await page.getByRole('table', { name: 'Users' }).getByRole('link', { name: name, exact: true }).click()
  await expect(page.getByRole('link', { name: /Back to Users/ })).toBeVisible()
}

test.describe('Employee timesheets', () => {
  test('ET-01 switches between Users, Timesheets and Roles & permissions', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await expect(entriesHeading(page)).toBeVisible()

    await page.getByRole('tab', { name: 'Roles & permissions' }).click()
    await expect(page).toHaveURL(/tab=roles/)
    await expect(page.getByRole('table', { name: 'Permission matrix' })).toBeVisible()

    await page.getByRole('tab', { name: 'Users', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Users' })).toBeVisible()

    await page.getByRole('tab', { name: 'Timesheets', exact: true }).click()
    await expect(entriesHeading(page)).toBeVisible()
  })

  test('ET-02 date range changes the totals and the entries (super)', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*20/)

    await page.getByRole('combobox', { name: 'Date range' }).selectOption({ label: 'This week' })
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*16/)
    await expect(entryRows(page)).toHaveCount(16)
  })

  test('ET-03 clicking a project bar filters the entries to that project', async ({ page }) => {
    await openEmployeeTimesheets(page)
    // The table fills in after the data loads; read it only once every row is there.
    await expect(entryRows(page)).toHaveCount(20)
    const before = await tableCells(entriesTable(page), 2)
    const target = before[0]
    const section = page.getByRole('region', { name: 'By project' })

    await section.getByRole('button', { name: new RegExp('^' + escapeRe(target)) }).click()
    await expect(section.getByRole('button', { name: new RegExp('^' + escapeRe(target)) })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible()
    const after = await tableCells(entriesTable(page), 2)
    expect(after).toEqual(before.filter(p => p === target))

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*20/)
  })

  test('ET-03 clicking an employee filters the entries to that person', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await page.getByRole('region', { name: 'By employee' }).getByRole('button', { name: /^Rahul/ }).click()
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*7/)
    expect(await tableCells(entriesTable(page), 1)).toEqual(Array(7).fill('Rahul'))
  })

  test('ET-04 role and billable filters narrow the entries table', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await page.getByRole('combobox', { name: 'Filter by role' }).selectOption({ label: 'Developer' })
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*12/)
    const people = new Set(await tableCells(entriesTable(page), 1))
    expect([...people].sort()).toEqual(['Bharath Reddy Panyala', 'Chary'])

    await page.getByRole('combobox', { name: 'Billable filter' }).selectOption({ label: 'Non-billable only' })
    await expect(entriesHeading(page)).toHaveText(/Entries\s*·\s*1/)
    await expect(entryRows(page)).toHaveCount(1)
  })

  test('ET-05 opens an employee profile from the Users tab', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await openProfile(page, 'Chary')
    await expect(page).toHaveURL(/\/employee-timesheets\/3$/)
    await expect(page.getByText('Working on:')).toBeVisible()
    await page.getByRole('link', { name: /Back to Users/ }).click()
    await expect(page.getByRole('table', { name: 'Users' })).toBeVisible()
  })

  test('ET-06 approving a pending leave request marks it Approved and keeps it after reload', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await openProfile(page, 'Chary')
    await addLeave(page, 'E2E approve')

    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.getByText('Approved leave for Chary.', { exact: false })).toBeVisible()
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByText('E2E approve')).toBeVisible()
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({ timeout: 8_000 })
  })

  test('ET-06 rejecting a pending leave request marks it Rejected', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await openProfile(page, 'Chary')
    await addLeave(page, 'E2E reject')

    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.getByText('Rejected leave for Chary.')).toBeVisible()
    await expect(page.getByText('Rejected', { exact: true }).first()).toBeVisible()
  })

  test('ET-07 adding leave creates a Pending request that persists', async ({ page }) => {
    await openEmployeeTimesheets(page)
    await openProfile(page, 'Chary')
    await addLeave(page, 'E2E leave request')

    await expect(page.getByText('Leave requested. It stays pending until it is approved.')).toBeVisible()
    await expect(page.getByText('2 pending', { exact: true })).toBeVisible()
    await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByText('2 pending', { exact: true })).toBeVisible({ timeout: 8_000 })
  })

  test('ET-08 Add user is reachable from the Users tab of this page', async ({ page }) => {
    await openEmployeeTimesheets(page, '?tab=users')
    await page.getByRole('button', { name: 'Add user', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add a user' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('ET-09 toggling a role permission updates the matrix and the role card, and persists', async ({ page }) => {
    await openEmployeeTimesheets(page, '?tab=roles')
    const cell = page.getByRole('button', { name: 'Project manager: Export reports' })
    await expect(cell).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('8 of 14 permissions')).toBeVisible()

    await cell.click()
    await expect(cell).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByText('7 of 14 permissions')).toBeVisible()

    // The matrix updates before the mock backend commits; reload only once the change is stored.
    await expect.poll(() => storedPerms(page, 'pm')).not.toContain('ts.export')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Project manager: Export reports' })).toHaveAttribute('aria-pressed', 'false', { timeout: 8_000 })
  })

  test('ET-10 adds a developer type to the list and it persists', async ({ page }) => {
    await openEmployeeTimesheets(page, '?tab=roles')
    await page.getByRole('textbox', { name: 'New developer type' }).fill('Data')
    await page.getByRole('button', { name: '+ Add', exact: true }).click()
    await expect(page.getByText('Added developer type Data.')).toBeVisible()
    await expect(page.getByText('Data', { exact: true })).toBeVisible()

    await page.reload()
    await expect(page.getByText('Data', { exact: true })).toBeVisible({ timeout: 8_000 })
  })

  test('ET-10 rejects a developer type that already exists', async ({ page }) => {
    await openEmployeeTimesheets(page, '?tab=roles')
    await page.getByRole('textbox', { name: 'New developer type' }).fill('frontend')
    await page.getByRole('button', { name: '+ Add', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('That type is already in the list.')
  })
})

/** Adds a leave request on the profile page that is open. */
async function addLeave(page: Page, reason: string) {
  await page.getByRole('button', { name: 'Add leave', exact: true }).click()
  await page.getByLabel('From', { exact: true }).fill('2026-10-12')
  await page.getByLabel('To', { exact: true }).fill('2026-10-13')
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill(reason)
  await page.getByRole('button', { name: 'Save request', exact: true }).click()
}
