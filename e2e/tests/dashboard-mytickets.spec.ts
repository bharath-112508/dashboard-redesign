import { test, expect, type Page } from '@playwright/test'
import { signIn, type Role } from './helpers/session'
import {
  logTextEntry,
  durationButton,
  pickTicket,
  primeStore,
  setDuration,
  setTaskDue,
  waitForStored,
} from './helpers/dashboard'

/** Seeded critical open tickets for the super admin (PMT-12). */
const SUPER_CRITICAL_COUNT = 1

async function openDashboard(page: Page, role: Role, firstName: string) {
  await signIn(page, role)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(firstName)
}

async function openMyTickets(page: Page, role: Role) {
  await signIn(page, role)
  await page.goto('/my-tickets')
  await expect(page.getByRole('heading', { name: 'My tickets', level: 1 })).toBeVisible()
}

/** The main My tickets list card (the section that holds the tabs). */
const listCard = (page: Page) => page.locator('section', { has: page.getByRole('tablist') })

/** The "Needs you now" band, when it is shown. */
const needsBand = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Needs you now' }) })

test.describe('Dashboard', () => {
  test('DB-01 a KPI card opens its target page (super: Active projects opens Projects)', async ({ page }) => {
    await openDashboard(page, 'super', 'Rahul')
    await page.getByRole('link', { name: /Active projects/i }).click()
    await expect(page).toHaveURL(/\/projects$/)
  })

  test('DB-01 a KPI card opens its target page (dev: Logged this week opens My timesheet)', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('link', { name: /Logged this week/i }).click()
    await expect(page).toHaveURL(/\/timesheet$/)
  })

  test('DB-02 super: Critical open opens the Critical tickets drawer with the KPI count', async ({ page }) => {
    await openDashboard(page, 'super', 'Rahul')
    await page.getByRole('button', { name: /Critical open/i }).click()
    const drawer = page.getByRole('dialog', { name: 'Critical tickets' })
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText(`${SUPER_CRITICAL_COUNT} ticket`)
    await expect(drawer.getByRole('link')).toHaveCount(SUPER_CRITICAL_COUNT)
    await expect(drawer.getByRole('link').first()).toContainText('PMT-12')
  })

  test('DB-02 admin: Overdue tickets drawer lists late tickets and closes with Escape', async ({ page }) => {
    await primeStore(page)
    await openDashboard(page, 'admin', 'Vivek')
    await setTaskDue(page, 10, '2026-10-08')
    await page.getByRole('button', { name: /Overdue tickets/i }).click()
    const drawer = page.getByRole('dialog', { name: 'Overdue tickets' })
    await expect(drawer).toContainText('1 ticket')
    await expect(drawer.getByRole('link', { name: /PMT-10/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  })

  test('DB-02 admin: Overdue tickets drawer shows the empty state when nothing is late', async ({ page }) => {
    await openDashboard(page, 'admin', 'Vivek')
    await page.getByRole('button', { name: /Overdue tickets/i }).click()
    const drawer = page.getByRole('dialog', { name: 'Overdue tickets' })
    await expect(drawer).toContainText('0 tickets')
    await expect(drawer).toContainText('Nothing here right now')
  })

  test('DB-03 super: a row in the Critical drawer opens that ticket', async ({ page }) => {
    await openDashboard(page, 'super', 'Rahul')
    await page.getByRole('button', { name: /Critical open/i }).click()
    await page.getByRole('dialog', { name: 'Critical tickets' }).getByRole('link').first().click()
    await expect(page).toHaveURL(/\/tickets\/board\?ticket=12$/)
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })

  test('DB-03 dev: a row in My tickets opens the ticket', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('link', { name: /PMT-10 Login with BankID/ }).click()
    await expect(page).toHaveURL(/\/tickets\/board\?ticket=10$/)
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })

  test('DB-04 a widget header link opens its page (super: Budget vs hours used, Projects)', async ({ page }) => {
    await openDashboard(page, 'super', 'Rahul')
    await page.getByRole('link', { name: 'Projects ›', exact: true }).click()
    await expect(page).toHaveURL(/\/projects$/)
  })

  test('DB-04 a widget header link opens its page (dev: My week, Timesheet)', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('link', { name: 'Timesheet ›', exact: true }).click()
    await expect(page).toHaveURL(/\/timesheet$/)
  })

  test('DB-05 the Log your time card is not offered to the super admin', async ({ page }) => {
    await openDashboard(page, 'super', 'Rahul')
    await expect(page.getByRole('heading', { name: 'Log your time' })).toHaveCount(0)
  })

  test('DB-05 picking a ticket shows its key and title on the picker button', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('button', { name: 'Choose a ticket' }).click()
    await page.getByRole('option', { name: /PMT-10/ }).click()
    await expect(page.getByRole('button', { name: /PMT-10.*Login with BankID/ })).toBeVisible()
  })

  test('DB-05 searching the ticket picker filters the list and reports no match', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('button', { name: 'Choose a ticket' }).click()
    const search = page.getByLabel('Search tickets')
    await search.fill('login with bankid')
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option', { name: /PMT-10/ })).toBeVisible()
    await search.fill('zzzz-no-such-ticket')
    await expect(page.getByText('No tickets found')).toBeVisible()
  })

  test('DB-06 Text mode shows the area input and Ticket mode shows the picker again', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await expect(page.getByPlaceholder('Area worked on, e.g. Sprint planning')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose a ticket' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Ticket', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Choose a ticket' })).toBeVisible()
    await expect(page.getByPlaceholder('Area worked on, e.g. Sprint planning')).toHaveCount(0)
  })

  test('DB-07 the billable duration shows the hours and minutes chosen', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await expect(durationButton(page, 'Billable')).toContainText('0h 0m')
    await setDuration(page, 'Billable', 2, 30)
    await expect(durationButton(page, 'Billable')).toContainText('2h 30m')
  })

  test('DB-08 saving a ticket entry adds it to the list, updates Today and the week total', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await pickTicket(page, 'PMT-10')
    await setDuration(page, 'Billable', 1, 0)
    await page.getByPlaceholder('What did you do?').fill('Morning standup')
    await page.getByRole('button', { name: 'Save time entry' }).click()

    await expect(page.getByRole('button', { name: 'Remove PMT-10' })).toBeVisible()
    await expect(page.getByText('Today 1h', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /Logged this week/i })).toContainText('28h 30m')

    await expect(page.getByPlaceholder('What did you do?')).toHaveValue('')
    await expect(durationButton(page, 'Billable')).toContainText('0h 0m')

    await waitForStored(page, 'Morning standup', true)
    await page.reload()
    await expect(page.getByText('Today 1h', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove PMT-10' })).toBeVisible()

    await page.goto('/my-tickets')
    await expect(page.getByText('28h 30m', { exact: true })).toBeVisible()
  })

  test('DB-08 billable and non-billable hours in one save are both kept on one entry', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await pickTicket(page, 'PMT-10')
    await setDuration(page, 'Billable', 1, 0)
    await setDuration(page, 'Non-billable', 0, 30)
    await page.getByRole('button', { name: 'Save time entry' }).click()

    const row = page.locator('li', { has: page.getByRole('button', { name: 'Remove PMT-10' }) })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Billable')
    await expect(row).toContainText('Non-billable')
    await expect(page.getByText('Today 1h 30m', { exact: true })).toBeVisible()
  })

  test('DB-08 saving a text entry keeps the non-billable hours and the area', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await page.getByLabel('Area worked on').fill('Sprint planning')
    await setDuration(page, 'Non-billable', 0, 30)
    await page.getByRole('button', { name: 'Save time entry' }).click()

    const row = page.locator('li', { has: page.getByRole('button', { name: 'Remove Sprint planning' }) })
    await expect(row).toContainText('Sprint planning')
    await expect(row).toContainText('Non-billable')
    await expect(row).not.toContainText('Billable')
    await expect(page.getByText('Today 30m', { exact: true })).toBeVisible()

    await waitForStored(page, 'Sprint planning', true)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Remove Sprint planning' })).toBeVisible()
  })

  test('DB-08 Save does nothing until a ticket and a duration are set', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    const save = page.getByRole('button', { name: 'Save time entry' })
    await expect(save).toHaveAttribute('aria-disabled', 'true')
    await pickTicket(page, 'PMT-10')
    await expect(save).toHaveAttribute('aria-disabled', 'true')
    await setDuration(page, 'Billable', 1, 0)
    await expect(save).toHaveAttribute('aria-disabled', 'false')
  })

  test('DB-09 Clear resets the notes, the area and both durations', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await page.getByLabel('Area worked on').fill('Draft area')
    await page.getByPlaceholder('What did you do?').fill('Draft note')
    await setDuration(page, 'Billable', 1, 0)
    await setDuration(page, 'Non-billable', 0, 15)

    await page.getByRole('button', { name: 'Clear form' }).click()
    await expect(page.getByLabel('Area worked on')).toHaveValue('')
    await expect(page.getByPlaceholder('What did you do?')).toHaveValue('')
    await expect(durationButton(page, 'Billable')).toContainText('0h 0m')
    await expect(durationButton(page, 'Non-billable')).toContainText('0h 0m')
  })

  test('DB-10 removing a logged entry drops it from the list and the Today total', async ({ page }) => {
    await openDashboard(page, 'dev', 'Chary')
    await logTextEntry(page, 'Sprint planning', 'To remove')
    await expect(page.getByText('Today 1h', { exact: true })).toBeVisible()
    await waitForStored(page, 'Sprint planning', true)

    await page.getByRole('button', { name: 'Remove Sprint planning' }).click()
    await expect(page.getByRole('button', { name: 'Remove Sprint planning' })).toHaveCount(0)
    await expect(page.getByText('Today 0m', { exact: true })).toBeVisible()

    await waitForStored(page, 'Sprint planning', false)
    await page.reload()
    await expect(page.getByText('Today 0m', { exact: true })).toBeVisible()
  })

  test('DB-11 a client question in the widget opens that question', async ({ page }) => {
    await openDashboard(page, 'cuser', 'Lars')
    await page.getByRole('link', { name: /Which languages at launch/ }).click()
    await expect(page).toHaveURL(/\/clients\/board\?question=1$/)
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })
})

test.describe('My tickets', () => {
  test('MT-01 search matches a ticket title', async ({ page }) => {
    await openMyTickets(page, 'dev')
    await page.getByRole('textbox', { name: 'Search my tickets' }).fill('bankid')
    await expect(page.locator('[data-row="PMT-10"]')).toBeVisible()
    await expect(page.locator('[data-row="PMT-12"]')).toHaveCount(0)
  })

  test('MT-01 search matches a ticket key, and reports no match for an unknown term', async ({ page }) => {
    await openMyTickets(page, 'dev')
    const search = page.getByRole('textbox', { name: 'Search my tickets' })
    await search.fill('PMT-12')
    await expect(page.locator('[data-row="PMT-12"]')).toBeVisible()
    await expect(page.locator('[data-row="PMT-10"]')).toHaveCount(0)
    await search.fill('zzzz-no-such-ticket')
    await expect(page.getByText('No tickets match these filters.')).toBeVisible()
  })

  test('MT-02 the Done tab shows done tickets and leaves the tab counts unchanged', async ({ page }) => {
    await openMyTickets(page, 'super')
    await expect(page.getByRole('tab', { name: /^Open/ })).toContainText('3')
    await page.getByRole('tab', { name: /^Done/ }).click()
    await expect(page.getByRole('tab', { name: /^Done/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-row="PMT-9"]')).toBeVisible()
    await expect(page.locator('[data-row="PMT-11"]')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^Open/ })).toContainText('3')
    await expect(page.getByRole('tab', { name: /^Done/ })).toContainText('1')
    await expect(page.getByRole('tab', { name: /^All/ })).toContainText('4')
  })

  test('MT-03 the project chip limits the list to that project', async ({ page }) => {
    await openMyTickets(page, 'super')
    await expect(page.locator('[data-row="PMT-11"]')).toBeVisible()
    await page.getByRole('button', { name: 'Web app', exact: true }).click()
    await expect(page.locator('[data-row="PMT-4"]')).toBeVisible()
    await expect(page.locator('[data-row="PMT-11"]')).toHaveCount(0)
    await expect(page.locator('[data-row="PMT-16"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    await expect(page.locator('[data-row="PMT-11"]')).toBeVisible()
  })

  test('MT-04 grouping by due date shows due groups, including Overdue', async ({ page }) => {
    await primeStore(page)
    await openMyTickets(page, 'dev')
    await setTaskDue(page, 10, '2026-10-08')
    await expect(listCard(page).getByText('Overdue', { exact: true })).toBeVisible()
    await expect(listCard(page).locator('[data-row="PMT-10"]')).toBeVisible()
    await expect(page.getByLabel('Group by')).toHaveValue('due')
  })

  test('MT-04 grouping by sprint and by project switches the group headers', async ({ page }) => {
    await openMyTickets(page, 'super')
    const list = listCard(page)
    await page.getByLabel('Group by').selectOption('sprint')
    await expect(list.getByText('Sprint 2 · Mobile app', { exact: true })).toBeVisible()
    await expect(list.getByText('Sprint 1 · Web app', { exact: true })).toBeVisible()
    await page.getByLabel('Group by').selectOption('proj')
    await expect(list.locator('.bg-canvas').filter({ hasText: 'Web app' })).toContainText('1')
    await expect(list.locator('.bg-canvas').filter({ hasText: 'Mobile app' })).toContainText('2')
  })

  test('MT-05 a row opens its ticket', async ({ page }) => {
    await openMyTickets(page, 'dev')
    await page.locator('[data-row="PMT-10"]').click()
    await expect(page).toHaveURL(/\/tickets\/board\?ticket=PMT-10$/)
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })

  test('MT-05 a Needs you now row opens its ticket', async ({ page }) => {
    await openMyTickets(page, 'dev')
    await needsBand(page).getByRole('link', { name: /PMT-12/ }).click()
    await expect(page).toHaveURL(/\/tickets\/board\?ticket=PMT-12$/)
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })

  test('MT-06 a My sprints card opens that sprint on the Tickets plan', async ({ page }) => {
    await openMyTickets(page, 'dev')
    await page.getByRole('link', { name: /Sprint 2 · Mobile app/ }).click()
    await expect(page).toHaveURL(/\/tickets\/plan\?sprint=/)
  })

  test('MT-06 a My epics card opens that epic on the Tickets plan', async ({ page }) => {
    await openMyTickets(page, 'dev')
    await page.getByRole('link', { name: /Mobile app 2 open/ }).click()
    await expect(page).toHaveURL(/\/tickets\/plan\?epic=mob$/)
  })

  test('MT-07 the Open tickets KPI switches to the Open tab and sorts by due date', async ({ page }) => {
    await openMyTickets(page, 'super')
    await page.getByRole('tab', { name: /^Done/ }).click()
    await page.getByLabel('Group by').selectOption('sprint')
    await page.getByRole('button', { name: /Open tickets/ }).click()
    await expect(page.getByRole('tab', { name: /^Open/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Group by')).toHaveValue('due')
    await expect(listCard(page).getByText('Later', { exact: true })).toBeVisible()
  })

  test('MT-08 All my tickets comes before My sprints; the week hours and recent activity cards are gone', async ({ page }) => {
    await openMyTickets(page, 'dev')
    const list = page.getByRole('heading', { name: 'All my tickets' })
    const sprints = page.getByRole('heading', { name: 'My sprints' })
    await expect(list).toBeVisible()
    const [a, b] = [await list.boundingBox(), await sprints.boundingBox()]
    expect(a!.y).toBeLessThan(b!.y)
    await expect(page.getByRole('heading', { name: 'My hours this week' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Recent on my tickets' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Log time ›' })).toHaveCount(0)
  })

  test('MT-09 a row shows priority, subtasks done, due date and status', async ({ page }) => {
    await openMyTickets(page, 'dev')
    // PMT-10 Login with BankID: High, 1 of 2 subtasks done, In progress.
    const row = page.locator('[data-row="PMT-10"]')
    await expect(row.getByTitle('Priority')).toHaveText('High')
    await expect(row.getByTitle('Subtasks done')).toContainText('1 of 2 subtasks')
    await expect(row).toContainText('In progress')
    await expect(row).toContainText('Mobile app')
  })
})
