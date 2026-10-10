import { readFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { signIn, type Role } from './helpers/session'
import { storedDb, tableCells } from './helpers/people-time'

/** Roles that see the My timesheet page in the sidebar (00-shell). */
const TIME_ROLES: Role[] = ['super', 'admin', 'pm', 'dev', 'devops']

const logHours = (page: Page) => page.getByRole('spinbutton', { name: 'Hours', exact: true })
const logMinutes = (page: Page) => page.getByRole('spinbutton', { name: 'Minutes', exact: true })
const logButton = (page: Page) => page.getByRole('button', { name: 'Log time', exact: true })
const logForm = (page: Page) => page.getByRole('form', { name: 'Log time' })

async function openTimesheet(page: Page, role: Role = 'super') {
  await signIn(page, role)
  await page.goto('/timesheet')
  await expect(page.getByRole('heading', { level: 1, name: 'My timesheet' })).toBeVisible()
}

async function chooseProjectAndTicket(page: Page) {
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Daco · Daco platform' })
  const ticket = page.getByRole('combobox', { name: 'Ticket', exact: true })
  const first = ticket.locator('option').filter({ hasText: ' · ' }).first()
  await ticket.selectOption((await first.getAttribute('value')) ?? '')
}

test.describe('My timesheet', () => {
  for (const role of TIME_ROLES) {
    test(`TS-01 day strip selects a day (${role})`, async ({ page }) => {
      await openTimesheet(page, role)
      await page.getByRole('tab', { name: 'Fri 09 Oct 2026' }).click()
      await expect(page.getByRole('heading', { level: 2, name: '09 Oct 2026' })).toBeVisible()
      await expect(page.getByRole('heading', { level: 3, name: 'Log time for Fri 09 Oct 2026' })).toBeVisible()
    })
  }

  test('TS-01 selected day shows that day total from the store (super)', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'Thu 08 Oct 2026' }).click()
    await expect(page.getByText('5h logged', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Sat 10 Oct 2026' }).click()
    await expect(page.getByText('Nothing logged for this day yet.')).toBeVisible()
  })

  test('TS-02 previous and next week move the day strip', async ({ page }) => {
    await openTimesheet(page)
    await expect(page.getByRole('tab', { name: 'Mon 05 Oct 2026' })).toBeVisible()
    await page.getByRole('button', { name: 'Previous week' }).click()
    await expect(page.getByRole('tab', { name: 'Mon 28 Sep 2026' })).toBeVisible()
    await page.getByRole('button', { name: 'Next week' }).click()
    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page.getByRole('tab', { name: 'Mon 12 Oct 2026' })).toBeVisible()
    await page.getByRole('button', { name: 'This week' }).click()
    await expect(page.getByRole('tab', { name: 'Mon 05 Oct 2026' })).toBeVisible()
  })

  for (const role of TIME_ROLES) {
    test(`TS-03 ticket mode: logging time adds an entry and survives reload (${role})`, async ({ page }) => {
      await openTimesheet(page, role)
      await chooseProjectAndTicket(page)
      await logHours(page).fill('2')
      await logMinutes(page).fill('30')
      await logForm(page).getByRole('textbox', { name: 'Note', exact: true }).fill('E2E ticket entry')
      await logButton(page).click()
      await expect(page.getByRole('status').filter({ hasText: /^Saved / })).toBeVisible()
      await expect(page.getByText('2h 30m logged', { exact: true })).toBeVisible()
      await expect(page.getByText('E2E ticket entry')).toBeVisible()

      await expect.poll(async () => ((await storedDb(page)).entries ?? []).some(e => e.notes === 'E2E ticket entry')).toBe(true)
      await page.reload()
      await expect(page.getByText('2h 30m logged', { exact: true })).toBeVisible({ timeout: 8_000 })
      await expect(page.getByText('E2E ticket entry')).toBeVisible()
    })
  }

  test('TS-03 blocks a zero duration and saves nothing', async ({ page }) => {
    await openTimesheet(page)
    await chooseProjectAndTicket(page)
    await logButton(page).click()
    await expect(page.getByText('Add some hours')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: /^Saved / })).toHaveCount(0)
    await expect(page.getByText('Nothing logged for this day yet.')).toBeVisible()
  })

  test('TS-03 requires a project before a ticket can be chosen', async ({ page }) => {
    await openTimesheet(page)
    await expect(page.getByRole('combobox', { name: 'Ticket', exact: true })).toBeDisabled()
    await expect(page.getByRole('combobox', { name: 'Ticket', exact: true }).locator('option').first()).toHaveText('Choose a project first')
  })

  test('TS-04 text mode: a preset task is saved as the entry task', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Daco · Daco platform' })
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await page.getByRole('combobox', { name: 'Task', exact: true }).selectOption('Code review')
    await logHours(page).fill('1')
    await logButton(page).click()
    await expect(page.getByText('1h logged', { exact: true })).toBeVisible()
    await expect(page.locator('span').filter({ hasText: /^Code review$/ })).toBeVisible()

    await expect.poll(async () => ((await storedDb(page)).entries ?? []).some(e => e.area === 'Code review')).toBe(true)
    await page.reload()
    await expect(page.locator('span').filter({ hasText: /^Code review$/ })).toBeVisible({ timeout: 8_000 })
  })

  test('TS-04 text mode: a custom task needs a description', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Daco · Daco platform' })
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await logHours(page).fill('1')
    await logButton(page).click()
    await expect(page.getByText('Write what you worked on')).toBeVisible()
    await expect(page.getByText('Nothing logged for this day yet.')).toBeVisible()
  })

  test('TS-06 project filter in history limits rows to that project', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'History' }).click()
    const table = page.getByRole('table').first()
    const before = await tableCells(table, 1)
    expect(before.length).toBeGreaterThan(0)
    const target = before[0]

    await page.getByRole('combobox', { name: 'Project filter' }).selectOption({ label: target })
    await expect(page.getByRole('button', { name: 'Show all my time' })).toBeVisible()
    const after = await tableCells(table, 1)
    expect(after).toEqual(before.filter(p => p === target))
  })

  test('TS-07 submit week locks the week and survives reload', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('button', { name: 'Submit week', exact: true }).click()
    await expect(page.getByText(/Submitted 10 Oct 2026/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reopen week', exact: true })).toBeVisible()
    await expect(page.getByText('This week is locked.')).toBeVisible()
    await expect(logButton(page)).toBeDisabled()

    await expect.poll(async () => ((await storedDb(page)).weekSubmissions ?? []).length).toBe(1)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Reopen week', exact: true })).toBeVisible({ timeout: 8_000 })
  })

  test('TS-08 reopen week unlocks the week and survives reload', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('button', { name: 'Submit week', exact: true }).click()
    await page.getByRole('button', { name: 'Reopen week', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Submit week', exact: true })).toBeVisible()
    await expect(logButton(page)).toBeEnabled()

    await expect.poll(async () => ((await storedDb(page)).weekSubmissions ?? []).length).toBe(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Submit week', exact: true })).toBeVisible({ timeout: 8_000 })
  })

  test('TS-09 history period changes the entries shown (super)', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'History' }).click()
    const period = page.getByRole('combobox', { name: 'Period' })
    await expect(page.getByText('7 entries', { exact: true })).toBeVisible()

    await period.selectOption({ label: 'This week' })
    await expect(page.getByText('4 entries', { exact: true })).toBeVisible()
    await period.selectOption({ label: 'Last month' })
    await expect(page.getByText('2 entries', { exact: true })).toBeVisible()
    await period.selectOption({ label: 'This month' })
    await expect(page.getByText('5 entries', { exact: true })).toBeVisible()

    await period.selectOption({ label: 'Custom range' })
    await page.getByRole('textbox', { name: 'From' }).fill('2026-10-01')
    await page.getByRole('textbox', { name: 'To' }).fill('2026-10-07')
    await expect(page.getByText('2 entries', { exact: true })).toBeVisible()
  })

  test('TS-10 group by regroups the history rows (super)', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'History' }).click()
    const groupBy = page.getByRole('combobox', { name: 'Group by' })
    await expect(page.getByRole('heading', { level: 3, name: 'Fri 09 Oct 2026' })).toBeVisible()

    await groupBy.selectOption({ label: 'Task' })
    await expect(page.getByRole('heading', { level: 3, name: 'Fri 09 Oct 2026' })).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 3, name: /Push notifications setup/ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: /Push notifications setup/ }).locator('..').getByText('10h', { exact: true })).toBeVisible()
  })

  test('TS-11 CSV download has the documented headers (super)', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'History' }).click()
    await page.getByRole('button', { name: 'Download' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^CSV/ }).click()])
    expect(download.suggestedFilename()).toBe('my-timesheet-all-time.csv')
    const text = readFileSync((await download.path())!, 'utf8').replace(/^\uFEFF/, '')
    expect(text.split(/\r?\n/)[0]).toBe('Date,Project,Type,Ticket,Task,Hours,Billable,Note')
    expect(text.split(/\r?\n/).filter(Boolean)).toHaveLength(1 + 7)
  })

  test('TS-11 Excel and PDF downloads are offered (super)', async ({ page }) => {
    await openTimesheet(page)
    await page.getByRole('tab', { name: 'History' }).click()
    await page.getByRole('button', { name: 'Download' }).click()
    await expect(page.getByRole('menuitem', { name: /^Excel/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^PDF report/ })).toBeVisible()

    const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Excel/ }).click()])
    expect(xlsx.suggestedFilename()).toBe('my-timesheet-all-time.xlsx')

    await page.getByRole('button', { name: 'Download' }).click()
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^PDF report/ }).click()])
    expect(pdf.suggestedFilename()).toBe('my-timesheet-all-time.pdf')
  })

  test('TS-12 Companies "Timesheets" link limits projects to that company', async ({ page }) => {
    await signIn(page, 'super')
    await page.goto('/companies/daco')
    await page.getByRole('link', { name: 'Timesheets', exact: true }).click()
    await expect(page).toHaveURL(/\/timesheet\?company=daco/)
    await expect(page.getByText(/Showing projects for/)).toContainText('Daco')

    const projectOptions = page.getByRole('combobox', { name: 'Project', exact: true }).locator('option')
    await expect(projectOptions.filter({ hasText: 'Daco platform' })).toHaveCount(1)
    await expect(projectOptions.filter({ hasText: 'Business portal' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Show all projects' }).click()
    await expect(page).not.toHaveURL(/company=/)
    await expect(page.getByRole('combobox', { name: 'Project', exact: true }).locator('option').filter({ hasText: 'Business portal' })).toHaveCount(1)
  })
})
