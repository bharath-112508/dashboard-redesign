import { test, expect } from '@playwright/test'
import { signIn } from './helpers/session'
import {
  cardsOn,
  moveClientStep,
  openPanelTab,
  openProject,
  openSettings,
  panelOf,
  pickStatus,
  pressEscape,
  settingsInput,
  settingsOf,
  settingsRow,
  statusModal,
  storedDevopsSettings,
  storedProject,
  storedLadderHours,
} from './helpers/devops'

/**
 * Board tests run as Arjun (DevOps). Seed: OPS-102 Intranet · Inoff (client, step 1), OPS-108 Webshop · OSBY (dev team), OPS-101 Daco platform · Daco (not started).
 * v5: every DevOps item is a project (Intranet is the Inoff company's project `inoffp`, and so on).
 */
test.describe('DevOps board', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'devops')
  })

  test('DO-01 Switch List / Board: the header switch changes the view and keeps the project set', async ({ page }) => {
    await page.goto('/devops/board')
    await page.getByTitle('List', { exact: true }).click()
    await expect(page).toHaveURL(/\/devops\/list/)
    await expect(page.getByRole('button', { name: /^Project/ })).toBeVisible()
    await expect(page.getByText('Intranet', { exact: true })).toBeVisible()
    await page.getByTitle('Board', { exact: true }).click()
    await expect(page).toHaveURL(/\/devops\/board/)
    await expect(cardsOn(page)).toHaveCount(11)
  })

  test('DO-02 Filter: each filter tab shows the cards its count badge says', async ({ page }) => {
    await page.goto('/devops/board')
    for (const label of ['Due now', 'Client', 'Dev team', 'Escalated', 'Rescheduled']) {
      const tab = page.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
      const count = Number((await tab.innerText()).replace(label, '').trim())
      await tab.click()
      await expect(cardsOn(page)).toHaveCount(count)
    }
  })

  test('DO-02 Filter: the Sequence switch (Client / Internal) narrows the project set', async ({ page }) => {
    await page.goto('/devops/board')
    await expect(cardsOn(page)).toHaveCount(11)
    await page.getByRole('button', { name: 'Internal', exact: true }).click()
    const allCount = Number((await page.getByRole('button', { name: /^All\s*\d+$/ }).innerText()).replace('All', '').trim())
    await expect(cardsOn(page)).toHaveCount(allCount)
    expect(allCount).toBeLessThan(11)
  })

  test('DO-03 Search: header search matches project name and key', async ({ page }) => {
    await page.goto('/devops/board')
    const search = page.getByPlaceholder('Search projects, owners, notes…')
    await search.fill('Intranet')
    await expect(cardsOn(page)).toHaveCount(1)
    await expect(page.locator('[data-card="OPS-102"]')).toBeVisible()
    await search.fill('OPS-109')
    await expect(cardsOn(page)).toHaveCount(1)
    await expect(page.locator('[data-card="OPS-109"]')).toBeVisible()
  })

  test('DO-04 Change status by drag: dropping a card on another column opens the Change status window and moves nothing yet', async ({ page }) => {
    await page.goto('/devops/board')
    await page.locator('[data-card="OPS-101"]').dragTo(page.locator('[data-column="Dev project deployment"]'))
    await expect(statusModal(page)).toBeVisible()
    await expect(statusModal(page).getByText('Change status', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(statusModal(page)).toHaveCount(0)
    await expect(page.locator('[data-column="Not started"] [data-card="OPS-101"]')).toBeVisible()
  })

  test('DO-05 Change status (window): picking a status and saving logs the change', async ({ page }) => {
    await openProject(page, 'OPS-102')
    await pickStatus(page, 'Dev project deployment')
    await expect(statusModal(page)).toBeVisible()
    await statusModal(page).getByRole('textbox', { name: 'Reason' }).fill('Dev environment is ready for testing')
    await statusModal(page).getByRole('button', { name: 'Save & log' }).click()
    await expect(statusModal(page)).toHaveCount(0)
    await expect(panelOf(page).getByRole('button', { name: 'Dev project deployment' }).first()).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panelOf(page).getByText('Status changed to Dev project deployment', { exact: true })).toBeVisible()
    await page.reload()
    await expect(panelOf(page).getByText('Dev project deployment', { exact: true }).first()).toBeVisible()
  })

  test('DO-06 Edit status description: the new description is saved for this project and logged', async ({ page }) => {
    await openProject(page, 'OPS-102')
    await panelOf(page).getByRole('button', { name: 'Edit status description' }).click()
    await expect(statusModal(page).getByText('Edit status description', { exact: true })).toBeVisible()
    await statusModal(page).getByRole('textbox', { name: 'Description' }).fill('Waiting for Azure tenant access from DACO')
    await statusModal(page).getByRole('button', { name: 'Save & log' }).click()
    await expect(panelOf(page).getByText('Waiting for Azure tenant access from DACO', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panelOf(page).getByText('Status description updated', { exact: true })).toBeVisible()
  })

  test('DO-07 Client sequence: move to step saves the note, the next reminder and advances the step', async ({ page }) => {
    await openProject(page, 'OPS-102')
    await moveClientStep(page, 'Reminder 2', 'Called the client, tenant details still missing', '2026-10-20T09:00')
    const panel = panelOf(page)
    await expect(panel.getByText('Called the client, tenant details still missing', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Move to Reminder 3', exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Moved to Reminder 2', { exact: true })).toBeVisible()
    await page.reload()
    await openPanelTab(page, 'Follow-ups')
    await expect(panelOf(page).getByText('Called the client, tenant details still missing', { exact: true })).toBeVisible()
    await expect(panelOf(page).getByRole('button', { name: 'Move to Reminder 3', exact: true })).toBeVisible()
  })

  test('DO-08 Edit client sequence dates: shifting a step moves the later steps and logs the schedule update', async ({ page }) => {
    await openProject(page, 'OPS-102')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Edit dates', exact: true }).click()
    await panel.locator('input[type="datetime-local"]').nth(2).fill('2026-10-25T07:00')
    await panel.getByRole('button', { name: 'Shift later steps' }).nth(2).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(panel.getByText('Planned 25 Oct 2026, 07:00', { exact: true })).toBeVisible()
    await expect(panel.getByText('Planned 27 Oct 2026, 07:00', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Follow-up schedule updated', { exact: true })).toBeVisible()
  })

  test('DO-09 Add a step for this project: the step appears in this project only and is logged', async ({ page }) => {
    await openProject(page, 'OPS-102')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: '+ Add step', exact: true }).click()
    await panel.getByPlaceholder("e.g. Call client's manager").fill("Call client's manager")
    await panel.getByRole('button', { name: 'Add step', exact: true }).click()
    await expect(panel.getByText("Call client's manager", { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText("Follow-up step added: Call client's manager", { exact: true })).toBeVisible()
    await page.goto('/devops/board?settings=seq')
    await expect(settingsInput(page, "Call client's manager")).toHaveCount(0)
  })

  test('DO-10 Internal follow-up: moving to the next internal step saves the date and the note', async ({ page }) => {
    await openProject(page, 'OPS-108')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Move to Inform team lead', exact: true }).click()
    await panel.getByPlaceholder('e.g. Dev team needs two more days for the API changes').fill('Testing still open, needs lead review')
    await panel.locator('label', { hasText: 'When is Inform team lead?' }).locator('input').fill('2026-10-25')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByText('Due 25 Oct 2026', { exact: true })).toBeVisible()
    await expect(panel.getByText('Testing still open, needs lead review', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Testing still open, needs lead review', { exact: true })).toBeVisible()
  })

  test('DO-10 Internal follow-up: starting an empty internal sequence sets the first date and logs it', async ({ page }) => {
    await openProject(page, 'OPS-101')
    const panel = panelOf(page)
    await panel.getByText('Action from', { exact: true }).locator('xpath=ancestor::div[.//button][1]').getByRole('button').first().click()
    await page.getByRole('button', { name: /^Development team/ }).click()
    await expect(panel.getByRole('button', { name: 'Start · set first date', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Start · set first date', exact: true }).click()
    await panel.locator('label', { hasText: 'When will you first follow up?' }).locator('input').fill('2026-10-20')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByText('Due 20 Oct 2026', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Internal follow-up set for 20 Oct 2026', { exact: true })).toBeVisible()
  })

  test('DO-11 Notes: a note can be added, edited and deleted, and each change is logged', async ({ page }) => {
    await openProject(page, 'OPS-102')
    const panel = panelOf(page)
    await panel.getByPlaceholder('Add a note for this project…').fill('Customer prefers Swedish invoices')
    await panel.getByRole('button', { name: 'Add note', exact: true }).last().click()
    await expect(panel.getByText('Customer prefers Swedish invoices', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Added note to Intranet', { exact: true })).toBeVisible()

    await openPanelTab(page, 'Follow-ups')
    await panel.getByRole('button', { name: 'Edit', exact: true }).last().click()
    await panel.locator('textarea').last().fill('Customer prefers English invoices')
    await panel.getByRole('button', { name: 'Save', exact: true }).last().click()
    await expect(panel.getByText('Customer prefers English invoices', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Edited note on Intranet', { exact: true })).toBeVisible()

    await openPanelTab(page, 'Follow-ups')
    await panel.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(panel.getByText('Customer prefers English invoices', { exact: true })).toHaveCount(0)
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Note deleted', { exact: true })).toBeVisible()
  })

  test('DO-12 Dev phase owner: setting the next step saves title, owner and due date', async ({ page }) => {
    await openProject(page, 'OPS-102', 'phases')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: /^Next step/ }).click()
    await expect(panel.getByText('Set date and owner', { exact: true })).toBeVisible()
    await panel.getByPlaceholder('Next step').fill('Build the Azure landing zone')
    await panel.getByRole('button', { name: /Chary$/ }).click()
    await panel.locator('label', { hasText: 'Due date' }).locator('input').fill('2026-10-30')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByText('Next: Build the Azure landing zone · due 30 Oct 2026', { exact: true })).toBeVisible()
    await expect.poll(() => storedProject(page, 'OPS-102', 'devStepTitle')).toBe('Build the Azure landing zone')
    await page.reload()
    await expect(panelOf(page).getByText('Next: Build the Azure landing zone · due 30 Oct 2026', { exact: true })).toBeVisible()
  })

  test('DO-13 Edit dev phase steps: a renamed step is saved for this project and logged', async ({ page }) => {
    await openProject(page, 'OPS-102', 'phases')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Edit steps for this project', exact: true }).click()
    await panel.locator('input[value="Development"]').fill('Dev build')
    await panel.getByRole('button', { name: 'Save steps', exact: true }).click()
    await expect(panel.getByText('Dev build', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Dev phase steps updated for this project', { exact: true })).toBeVisible()
  })

  test('DO-14 Reset dev steps: the default steps come back for this project', async ({ page }) => {
    await openProject(page, 'OPS-102', 'phases')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Edit steps for this project', exact: true }).click()
    await panel.locator('input[value="Development"]').fill('Dev build')
    await panel.getByRole('button', { name: 'Save steps', exact: true }).click()
    await expect(panel.getByText('Dev build', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Edit steps for this project', exact: true }).click()
    await panel.getByRole('button', { name: 'Reset to default steps', exact: true }).click()
    await expect(panel.getByText('Dev build', { exact: true })).toHaveCount(0)
    await expect(panel.getByText('Development', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Dev phase steps reset to defaults', { exact: true })).toBeVisible()
  })

  test('DO-15 Set DevOps phase: making the next phase current updates the phase and logs it', async ({ page }) => {
    await openProject(page, 'OPS-102', 'phases')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Make current phase', exact: true }).click()
    const dialog = page.locator('div.fixed').filter({ hasText: 'Does everything look right?' })
    await expect(dialog).toBeVisible()
    await dialog.locator('textarea').first().fill('Azure landing zone ready for review')
    await dialog.locator('input[type="date"]').fill('2026-11-15')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByText('Azure landing zone ready for review', { exact: true })).toBeVisible()
    await expect(panel.getByText('Not defined yet', { exact: true })).toBeVisible()
    await openPanelTab(page, 'Activity')
    await expect(panel.getByText('Next phase moved to current phase', { exact: true })).toBeVisible()
  })

  test('DO-16 Open a request: a row on the Tickets tab opens the request window', async ({ page }) => {
    await openProject(page, 'OPS-101', 'tickets')
    await panelOf(page).getByText('Need a staging environment for the Sprint 2 build', { exact: true }).click()
    await expect(page).toHaveURL(/request=1/)
    await expect(page.getByText('REQ-1', { exact: true }).first()).toBeVisible()
  })

  test('DO-17 Reply to a request: a comment sent from the request window is listed and kept after reload', async ({ page }) => {
    await page.goto('/devops/board?project=OPS-101&tab=tickets&request=1')
    await page.getByPlaceholder('Reply to the team…').fill('Staging is ready, access sent tomorrow')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Staging is ready, access sent tomorrow', { exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (localStorage.getItem('vt.clients.db') ?? '').includes('Staging is ready, access sent tomorrow')))
      .toBe(true)
    await page.reload()
    await expect(page.getByText('Staging is ready, access sent tomorrow', { exact: true })).toBeVisible()
  })

  test('DO-18 Raise a question to client: the question is created from the DevOps project and opens', async ({ page }) => {
    await openProject(page, 'OPS-102', 'cchat')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Raise a question to the client', exact: true }).click()
    await panel.getByPlaceholder('Title, e.g. Need DNS access for the new domain').fill('Need DNS access for the new domain')
    await panel.getByPlaceholder('Details for the client…').fill('Please grant DNS zone access to the DevOps team.')
    await panel.getByRole('button', { name: 'Raise to client', exact: true }).click()
    await expect(page).toHaveURL(/question=\d+/)
    await expect(page.getByText('Need DNS access for the new domain', { exact: true }).first()).toBeVisible()
    await page.reload()
    await expect(page).toHaveURL(/question=\d+/)
    await expect(page.getByText('Need DNS access for the new domain', { exact: true }).first()).toBeVisible()
  })

  test('DO-19 Mark question solved: the question shows as solved and the change is logged in its thread', async ({ page }) => {
    await page.goto('/devops/board?question=1')
    await page.getByRole('button', { name: 'Mark as solved', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Solved · reopen', exact: true })).toBeVisible()
    await expect(page.getByText('Marked as solved', { exact: true }).first()).toBeVisible()
  })

  test('DO-20 New project: picking a project gives the next OPS key and opens its panel (v5)', async ({ page }) => {
    await page.goto('/devops/board')
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await expect(page).toHaveURL(/new=1/)
    await page.getByRole('combobox', { name: 'Project' }).click()
    await page.getByRole('combobox', { name: 'Project' }).fill('business')
    await page.getByRole('option', { name: /Business portal/ }).click()
    await page.getByText('Initial due date', { exact: true }).click()
    await page.locator('input[type="date"][aria-label="Initial due date"]').fill('2026-12-15')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(page).toHaveURL(/project=OPS-112/)
    await expect(panelOf(page).getByRole('heading', { name: 'Business portal' })).toBeVisible()
    await expect(panelOf(page).getByText('OPS-112', { exact: true })).toBeVisible()
    await expect(panelOf(page).getByTestId('linked-project')).toContainText('Client project · Nordlys Energi')
    await expect.poll(() => storedProject(page, 'OPS-112', 'project')).toEqual({ kind: 'client', companyId: 'nord', id: 'nordp' })
  })

  test('DO-21 Settings: statuses - renaming a status moves its projects to the new name', async ({ page }) => {
    await openSettings(page, 'infra')
    await settingsInput(page, 'Not started').fill('Awaiting kickoff')
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(settingsOf(page)).toHaveCount(0)
    await expect(page.locator('[data-column="Awaiting kickoff"] [data-card="OPS-101"]')).toBeVisible()
  })

  test('DO-21 Settings: statuses - a new status with a description appears as a column', async ({ page }) => {
    await openSettings(page, 'infra')
    await settingsOf(page).getByRole('button', { name: '+ Add status', exact: true }).click()
    await settingsInput(page, 'New status').fill('Waiting on DNS')
    await settingsOf(page).getByPlaceholder('Default description for this status (optional)').last().fill('Waiting for DNS records from the client')
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.locator('[data-column="Waiting on DNS"]')).toContainText('Waiting for DNS records from the client')
  })

  test('DO-22 Settings: client sequence - a changed hours value is saved as the new default', async ({ page }) => {
    await openSettings(page, 'seq')
    await settingsRow(page, 'Reminder 1').locator('input[type="number"]').fill('36')
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => storedLadderHours(page, 1)).toBe(36)
    await openSettings(page, 'seq')
    await expect(settingsRow(page, 'Reminder 1').locator('input[type="number"]')).toHaveValue('36')
  })

  test('DO-22 Settings: internal sequence - a renamed internal step is saved', async ({ page }) => {
    await openSettings(page, 'seq')
    await settingsInput(page, 'Follow-up 1').fill('Chase dev team')
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(async () => (await storedDevopsSettings(page))?.iladder).toContain('Chase dev team')
    await openSettings(page, 'seq')
    await expect(settingsInput(page, 'Chase dev team')).toBeVisible()
  })

  test('DO-23 Settings: date rules - turning off the reminder rule lets a step move without a next reminder', async ({ page }) => {
    await openSettings(page, 'dates')
    await settingsOf(page).getByRole('button', { name: 'Require next reminder date', exact: true }).click()
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(async () => (await storedDevopsSettings(page))?.rules.requireReminder).toBe(false)
    await openProject(page, 'OPS-102')
    const panel = panelOf(page)
    await panel.getByRole('button', { name: 'Move to Reminder 2', exact: true }).click()
    await panel.getByPlaceholder('e.g. Sent second reminder, no reply from client').fill('Left a voicemail')
    await panel.locator('label', { hasText: 'Next reminder' }).locator('input').fill('')
    await panel.getByRole('button', { name: 'Move to Reminder 2', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Move to Reminder 3', exact: true })).toBeVisible()
  })

  test('DO-23 Settings: dev phases - a changed typical duration is saved', async ({ page }) => {
    await openSettings(page, 'dev')
    await settingsRow(page, 'Development').locator('input[type="number"]').fill('45')
    await settingsOf(page).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect
      .poll(async () => (await storedDevopsSettings(page))?.devPhases.find(p => p.name === 'Development')?.days)
      .toBe(45)
    await openSettings(page, 'dev')
    await expect(settingsRow(page, 'Development').locator('input[type="number"]')).toHaveValue('45')
  })

  test('DO-24 Escalation: a project that reaches the escalation step is listed under Escalated', async ({ page }) => {
    await openProject(page, 'OPS-102')
    await moveClientStep(page, 'Reminder 2', 'No reply, second reminder sent', '2026-10-20T09:00')
    await moveClientStep(page, 'Reminder 3', 'Still no reply', '2026-10-22T09:00')
    await moveClientStep(page, 'Inform Marcus', 'Client did not answer, informing Marcus', '2026-10-24T09:00')
    await pressEscape(page)
    await expect(panelOf(page)).toHaveCount(0)
    await page.getByRole('button', { name: /^Escalated\s*\d+$/ }).click()
    await expect(page.locator('[data-card="OPS-102"]')).toBeVisible()
  })

  test('DO-25 Due now: the bell filters the board to projects that are due', async ({ page }) => {
    await page.goto('/devops/board')
    await expect(page.getByTitle('Due now', { exact: true })).toContainText('2')
    await page.getByTitle('Due now', { exact: true }).click()
    await expect(page.getByRole('button', { name: /^Due now\s*\d+$/ })).toBeVisible()
    await expect(cardsOn(page)).toHaveCount(2)
    await expect(page.locator('[data-card="OPS-103"]')).toBeVisible()
    await expect(page.locator('[data-card="OPS-106"]')).toBeVisible()
    await expect(page.locator('[data-card="OPS-102"]')).toHaveCount(0)
  })

  test('DO-26 Layered Escape: Escape closes the status window first, then the project panel', async ({ page }) => {
    await openProject(page, 'OPS-102')
    await pickStatus(page, 'Dev project deployment')
    await expect(statusModal(page)).toBeVisible()
    await pressEscape(page)
    await expect(statusModal(page)).toHaveCount(0)
    await expect(panelOf(page)).toBeVisible()
    await pressEscape(page)
    await expect(panelOf(page)).toHaveCount(0)
  })

  test('DO-27 Project and Deployments: cards show the project (no client line), and the panel lists releases', async ({ page }) => {
    await page.goto('/devops/board')
    const card = page.locator('[data-card="OPS-106"]')
    await expect(card.getByText('Fast', { exact: true })).toBeVisible()
    // v5: the client line under the name is gone, and the tile uses the project's initials.
    await expect(card.getByText('ARC', { exact: true })).toHaveCount(0)
    await expect(card.getByText('F', { exact: true })).toBeVisible()
    await openProject(page, 'OPS-106')
    const panel = panelOf(page)
    await expect(panel.getByRole('heading', { name: 'Fast' })).toBeVisible()
    await expect(panel.getByText('Deployments', { exact: true })).toBeVisible()
    await expect(panel.locator('[data-release]')).toHaveCount(6)
    await expect(panel.locator('[data-release="2.5.3"]')).toContainText('rolled back')
    await openProject(page, 'OPS-102')
    await expect(panelOf(page).getByText('Deployments', { exact: true })).toHaveCount(0)
  })

  test('DO-28 Each DevOps item is a project: the panel shows the linked project, as text for DevOps who cannot open Projects (v5)', async ({ page }) => {
    await page.goto('/devops/list')
    // Scoped to the list: the status hover card (under the pointer left by sign-in) can also show the name.
    await expect(page.getByRole('main').getByText('Customer portal', { exact: true })).toBeVisible()
    await expect(page.getByText('Alnarp', { exact: true })).toHaveCount(0)

    await openProject(page, 'OPS-104')
    const linked = panelOf(page).getByTestId('linked-project')
    await expect(linked).toContainText('Customer portal')
    await expect(linked).toContainText('Client project · Alnarp')
    // The DevOps role cannot open /projects, so the name is not a link (it would only lead to "access denied").
    await expect(linked.getByText('Customer portal', { exact: true })).toBeVisible()
    await expect(linked.getByRole('link')).toHaveCount(0)
  })

  test('DO-29 New project: the project picker searches, blocks projects already on the board and can pick an internal project (v5)', async ({ page }) => {
    await page.goto('/devops/board?new=1')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(page.getByText('Pick a project', { exact: true }).last()).toBeVisible()

    const picker = page.getByRole('combobox', { name: 'Project' })
    await picker.click()
    await picker.fill('daco')
    const taken = page.getByRole('option', { name: /Daco platform/ })
    await expect(taken).toHaveAttribute('aria-disabled', 'true')
    await expect(taken).toContainText('On the board · OPS-101')
    await taken.click({ force: true })
    await expect(page.getByRole('listbox', { name: 'Projects' })).toBeVisible()

    await picker.fill('website')
    await expect(page.getByRole('group', { name: 'Internal projects' }).getByRole('option', { name: /Viljetech website/ })).toBeVisible()
    await picker.press('Enter') // the first free match: Fa tech's Website is on the board (OPS-107)
    await expect(page.getByRole('listbox', { name: 'Projects' })).toHaveCount(0)
    await expect(page.getByTestId('new-project')).toContainText('Internal project · Website & marketing')

    await page.getByText('Initial due date', { exact: true }).click()
    await page.locator('input[type="date"][aria-label="Initial due date"]').fill('2026-12-15')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(page).toHaveURL(/project=OPS-112/)
    await expect(panelOf(page).getByRole('heading', { name: 'Viljetech website' })).toBeVisible()
    await expect.poll(() => storedProject(page, 'OPS-112', 'project')).toEqual({ kind: 'internal', id: 'i2' })
    expect(await storedProject(page, 'OPS-112', 'kind')).toBe('internal')

    await page.reload()
    await expect(panelOf(page).getByTestId('linked-project')).toContainText('Internal project · Website & marketing')
  })

  test('DO-30 Search matches the project name and the DevOps key (v5)', async ({ page }) => {
    await page.goto('/devops/board')
    const search = page.getByPlaceholder('Search projects, owners, notes…')
    await search.fill('booking platform')
    await expect(cardsOn(page)).toHaveCount(1)
    await expect(page.locator('[data-card="OPS-109"]')).toBeVisible()
    await search.fill('ops-104')
    await expect(cardsOn(page)).toHaveCount(1)
    await expect(page.locator('[data-card="OPS-104"]')).toBeVisible()
  })

  test('DO-31 A store saved before v5 links its DevOps items to projects and keeps their data', async ({ page }) => {
    // Save the store once (a status description edit), then turn it back into a pre-v5 store.
    await openProject(page, 'OPS-102')
    await panelOf(page).getByRole('button', { name: 'Edit status description' }).click()
    await statusModal(page).getByRole('textbox', { name: 'Description' }).fill('Kept through the upgrade')
    await statusModal(page).getByRole('button', { name: 'Save & log' }).click()
    await expect.poll(() => storedProject(page, 'OPS-102', 'infraNote')).toBe('Kept through the upgrade')
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('vt.clients.db') as string)
      const strip = (p: Record<string, unknown>, client: string) => {
        delete p.project
        p.client = client
        p.kind = 'client'
      }
      const p102 = db.devops.projects.find((p: { key: string }) => p.key === 'OPS-102')
      strip(p102, 'Inoff')
      db.companies = db.companies.filter((c: { id: string }) => c.id !== 'inoff')
      const base = db.devops.projects.find((p: { key: string }) => p.key === 'OPS-110')
      const mk = (key: string, name: string, client: string) => {
        const p = { ...structuredClone(base), key, name }
        strip(p, client)
        return p
      }
      db.devops.projects.push(mk('OPS-120', 'Business portal', 'Nordlys Energi'), mk('OPS-121', 'Mystery app', 'Acme'))
      localStorage.setItem('vt.clients.db', JSON.stringify(db))
    })
    await page.goto('/devops/board?project=OPS-102')
    await expect(panelOf(page).getByText('Kept through the upgrade', { exact: true })).toBeVisible()
    await expect(panelOf(page).getByTestId('linked-project')).toContainText('Client project · Inoff')
    await openProject(page, 'OPS-120')
    await expect(panelOf(page).getByTestId('linked-project')).toContainText('Client project · Nordlys Energi')
    await openProject(page, 'OPS-121')
    await expect(panelOf(page).getByRole('heading', { name: 'Mystery app' })).toBeVisible()
    await expect(panelOf(page).getByTestId('linked-project')).toContainText('Not linked to a project')
  })
})

test.describe('DevOps board as an admin', () => {
  test('DO-32 The Project card links to Projects for roles that can open it, and the link searches for the project (v5)', async ({ page }) => {
    await signIn(page, 'admin')
    await openProject(page, 'OPS-104')
    const link = panelOf(page).getByTestId('linked-project').getByRole('link', { name: 'Customer portal' })
    await expect(link).toHaveAttribute('href', '/projects?q=Customer%20portal')
    await link.click()
    await expect(page).toHaveURL(/\/projects\?q=Customer(%20|\+)portal/)
    await expect(page.getByText(/does not have access/)).toHaveCount(0)
    await expect(page.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('Customer portal')
    await expect(page.getByRole('link', { name: 'Open Customer portal' })).toBeVisible()
  })
})
