import { test, expect, type Page } from '@playwright/test'
import { signIn } from './helpers/session'

/** A 1x1 transparent PNG, used as a company logo. */
const LOGO_PNG = {
  name: 'logo.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
}

const TODAY = '2026-10-10'

/** A panel on the company detail page, found by its heading. */
const panel = (page: Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

const companyCard = (page: Page, name: string) => page.getByRole('link', { name: new RegExp(`^${name}`) })

const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })

async function openCompanies(page: Page) {
  await signIn(page, 'super')
  await page.goto('/companies')
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible()
}

async function openCompany(page: Page, id: string) {
  await signIn(page, 'super')
  await page.goto(`/companies/${id}`)
  await expect(page.getByRole('link', { name: 'Back to Companies' })).toBeVisible()
}

async function openProjects(page: Page, role: 'super' | 'dev' = 'super') {
  await signIn(page, role)
  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: role === 'dev' ? 'My projects' : 'Projects', exact: true })).toBeVisible()
}

/** The "New project" dialog from the Projects page header. */
async function openNewProjectDialog(page: Page) {
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Start a new project' })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('Companies', () => {
  test('CO-01 search matches name, industry or country and shows a no-match message', async ({ page }) => {
    await openCompanies(page)
    // v5: the DevOps board's clients are companies too (each DevOps item is one of their projects).
    await expect(page.getByText('13 companies · 9 active projects')).toBeVisible()

    const search = page.getByPlaceholder('Search companies…')
    await search.fill('Energi')
    await expect(companyCard(page, 'Nordlys Energi')).toBeVisible()
    await expect(companyCard(page, 'Daco')).toHaveCount(0)

    await search.fill('Logistics')
    await expect(companyCard(page, 'Fjordline Logistics')).toBeVisible()

    await search.fill('no such company')
    await expect(page.getByText('No companies match your search.')).toBeVisible()
  })

  test('CO-02 filter tabs show Active, New and Archived companies', async ({ page }) => {
    await openCompanies(page)

    const tabs = page.getByRole('navigation', { name: 'Filter companies' })
    await tabs.getByRole('button', { name: /^Active/ }).click()
    await expect(companyCard(page, 'Daco')).toBeVisible()
    await expect(companyCard(page, 'Nordlys Energi')).toBeVisible()
    await expect(companyCard(page, 'Fjordline Logistics')).toHaveCount(0)

    await page.getByRole('navigation', { name: 'Filter companies' }).getByRole('button', { name: /^New/ }).click()
    await expect(companyCard(page, 'Havbruk AS')).toBeVisible()
    await expect(companyCard(page, 'Daco')).toHaveCount(0)

    await tabs.getByRole('button', { name: /^Archived/ }).click()
    await expect(page.getByText('No archived companies.')).toBeVisible()
  })

  test('CO-03 opens the company detail with its header and KPIs', async ({ page }) => {
    await openCompanies(page)
    await companyCard(page, 'Daco').click()
    await expect(page).toHaveURL(/\/companies\/daco$/)
    await expect(page.getByRole('heading', { name: 'Daco', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Daco platform' })).toBeVisible()
  })

  test('CO-03 shows the empty project and nobody-added messages (S-CO-4, S-CO-5)', async ({ page }) => {
    await openCompany(page, 'hav')
    await expect(page.getByText('No projects with Havbruk AS yet.')).toBeVisible()

    await openCompany(page, 'fjord')
    await expect(panel(page, 'Client contacts').getByText('Nobody added yet.')).toBeVisible()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Nobody added yet.')).toBeVisible()
    await expect(panel(page, 'About').getByText('Nothing written yet.')).toBeVisible()
  })

  test('CO-04 Back to Companies returns to the list', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('link', { name: 'Back to Companies' }).click()
    await expect(page).toHaveURL(/\/companies$/)
    await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible()
  })

  test('CO-05 creates a company, opens its detail and keeps it after reload', async ({ page }) => {
    await openCompanies(page)
    await page.getByRole('button', { name: 'New company', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a company' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Create company' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Add a company name')

    await dialog.getByLabel('Company name *').fill('Harbour Tech AS')
    await dialog.getByLabel('Industry', { exact: true }).fill('Shipping')
    await dialog.getByLabel('Country', { exact: true }).fill('Norway')
    await dialog.getByLabel('Main contact', { exact: true }).fill('Kim Berg')
    await dialog.getByLabel('Contact email').fill('kim@harbour.no')
    await dialog.getByRole('button', { name: 'Create company' }).click()

    await expect(page).toHaveURL(/\/companies\/c/)
    await expect(page.getByRole('heading', { name: 'Harbour Tech AS', level: 1 })).toBeVisible()
    await expect(panel(page, 'Client contacts').getByText('Kim Berg')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Harbour Tech AS', level: 1 })).toBeVisible()
  })

  test('CO-06 uploads a company logo and keeps it after reload', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByLabel('Company logo file').setInputFiles(LOGO_PNG)
    await expect(toast(page, 'Logo saved')).toBeVisible()
    await expect(page.locator('img[src^="data:image/png"]')).toBeVisible()

    await page.reload()
    await expect(page.locator('img[src^="data:image/png"]')).toBeVisible()
  })

  test('CO-07 removes a company logo and returns to the initials tile', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByLabel('Company logo file').setInputFiles(LOGO_PNG)
    await expect(page.locator('img[src^="data:image/png"]')).toBeVisible()

    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(toast(page, 'Logo removed')).toBeVisible()
    await expect(page.locator('img[src^="data:image/png"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Upload logo' })).toBeVisible()
  })

  test('CO-08 adds a website from "+ Website" and shows it as a link', async ({ page }) => {
    await openCompany(page, 'fjord')
    await page.getByRole('button', { name: '+ Website' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit company' })
    await dialog.getByLabel('Website', { exact: true }).fill('fjordline.se')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()

    const link = page.getByRole('link', { name: 'fjordline.se' })
    await expect(link).toHaveAttribute('href', 'https://fjordline.se')

    await page.reload()
    await expect(page.getByRole('link', { name: 'fjordline.se' })).toBeVisible()
  })

  test('CO-08 rejects an invalid website and does not save it', async ({ page }) => {
    await openCompany(page, 'fjord')
    await page.getByRole('button', { name: '+ Website' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit company' })
    await dialog.getByLabel('Website', { exact: true }).fill('not a site')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Enter a website such as daco.no')
    await expect(dialog).toBeVisible()
  })

  test('CO-09 starts a new project from the company and lists it under Projects', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('button', { name: 'Start new project' }).click()
    const dialog = page.getByRole('dialog', { name: 'Start a new project' })
    await expect(dialog.getByText('New project · Daco')).toBeVisible()
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Add a project name')

    await dialog.getByLabel('Project name *').fill('Daco reporting')
    await dialog.getByLabel('What are we building?').fill('Monthly reports for field teams.')
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Project started for Daco')).toBeVisible()
    await expect(page.getByRole('link', { name: /Daco reporting/ })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('link', { name: /Daco reporting/ })).toBeVisible()
  })

  test('CO-10 filters a company\'s projects by Ongoing and Done', async ({ page }) => {
    // v4 design: the Driver app is in Maintenance (support until 30 Aug 2027), so it counts as ongoing.
    await openCompany(page, 'fjord')
    await expect(page.getByRole('link', { name: /Driver app/ })).toBeVisible()

    await page.getByRole('tab', { name: 'Done', exact: true }).click()
    await expect(page.getByText('No projects in this view.')).toBeVisible()
    await expect(page.getByRole('link', { name: /Driver app/ })).toHaveCount(0)

    await page.getByRole('tab', { name: 'Ongoing', exact: true }).click()
    await expect(page.getByRole('link', { name: /Driver app/ })).toBeVisible()
    await expect(page.getByText('Support until 30 Aug 2027')).toBeVisible()
  })

  test('CO-11 adds a client contact and keeps it after reload', async ({ page }) => {
    await openCompany(page, 'hav')
    await panel(page, 'Client contacts').getByRole('button', { name: '+ Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a client contact' })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('Add a name')

    await dialog.getByLabel('Name *').fill('Mari Dahl')
    await dialog.getByLabel('Role').fill('Project manager')
    await dialog.getByLabel('Email').fill('mari@havbruk.no')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Client contacts').getByText('Mari Dahl')).toBeVisible()
    await expect(panel(page, 'Client contacts').getByText('Project manager · mari@havbruk.no')).toBeVisible()

    await page.reload()
    await expect(panel(page, 'Client contacts').getByText('Mari Dahl')).toBeVisible()
  })

  test('CO-12 edits a client contact', async ({ page }) => {
    await openCompany(page, 'daco')
    await panel(page, 'Client contacts').getByRole('button', { name: /Lars Moen/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit contact' })
    await dialog.getByLabel('Role').fill('Head of product')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Client contacts').getByText('Head of product · lars@daco.no')).toBeVisible()
  })

  test('CO-12 removes a client contact', async ({ page }) => {
    await openCompany(page, 'daco')
    await panel(page, 'Client contacts').getByRole('button', { name: /Lars Moen/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit contact' })
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Client contacts').getByText('Lars Moen')).toHaveCount(0)

    await page.reload()
    await expect(panel(page, 'Client contacts').getByText('Lars Moen')).toHaveCount(0)
  })

  test('CO-13 adds a responsible person with a role and project, and disables people already added', async ({ page }) => {
    await openCompany(page, 'nord')
    await panel(page, 'Responsible from Viljetech').getByRole('button', { name: '+ Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add someone responsible' })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByText('Pick a person', { exact: true })).toBeVisible()

    await dialog.getByRole('group', { name: 'Person' }).getByRole('button', { name: /Vivek/ }).click()
    await dialog.getByLabel('Role & access').selectOption('Admin')
    await dialog.getByRole('button', { name: 'Business portal' }).click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Vivek')).toBeVisible()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Admin · 1 project')).toBeVisible()

    await page.reload()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Admin · 1 project')).toBeVisible()
  })

  test('CO-13 disables people who are already responsible for the company', async ({ page }) => {
    await openCompany(page, 'daco')
    await panel(page, 'Responsible from Viljetech').getByRole('button', { name: '+ Add' }).click()
    const group = page.getByRole('dialog', { name: 'Add someone responsible' }).getByRole('group', { name: 'Person' })
    await expect(group.getByRole('button', { name: /Rahul/ })).toBeDisabled()
    await expect(group.getByRole('button', { name: /Chary/ })).toBeDisabled()
  })

  test('CO-14 edits a responsibility role', async ({ page }) => {
    await openCompany(page, 'daco')
    await panel(page, 'Responsible from Viljetech').getByRole('button', { name: /Chary/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit responsibility' })
    await dialog.getByLabel('Role & access').selectOption('Viewer')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Viewer · 1 project')).toBeVisible()
  })

  test('CO-14 removes a responsibility', async ({ page }) => {
    await openCompany(page, 'daco')
    await panel(page, 'Responsible from Viljetech').getByRole('button', { name: /Chary/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit responsibility' })
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Chary')).toHaveCount(0)

    await page.reload()
    await expect(panel(page, 'Responsible from Viljetech').getByText('Chary')).toHaveCount(0)
  })

  test('CO-15 archives a company with a warning about its active projects, and hides it', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Archive Daco?' })
    await expect(dialog.getByText('It still has 1 active project.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Archive company' }).click()

    await expect(page).toHaveURL(/\/companies$/)
    await expect(toast(page, 'Daco is archived')).toBeVisible()
    await expect(companyCard(page, 'Daco')).toHaveCount(0)

    await page.getByRole('button', { name: /^Archived/ }).click()
    await expect(companyCard(page, 'Daco')).toBeVisible()
  })

  test('CO-16 restores an archived company', async ({ page }) => {
    await openCompany(page, 'hav')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('dialog', { name: 'Archive Havbruk AS?' }).getByRole('button', { name: 'Archive company' }).click()
    await expect(page).toHaveURL(/\/companies$/)

    await page.getByRole('button', { name: /^Archived/ }).click()
    await companyCard(page, 'Havbruk AS').click()
    await expect(page.getByText(/^Archived on /)).toBeVisible()
    await page.getByRole('button', { name: 'Restore company' }).click()
    await expect(toast(page, 'Havbruk AS is restored')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore company' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
  })

  test('CO-17 Timesheets link opens the timesheet for the company', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('main').getByRole('link', { name: 'Timesheets', exact: true }).click()
    await expect(page).toHaveURL(/\/timesheet\?company=daco&name=Daco/)
  })

  test('CO-18 project row opens the tickets board', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('link', { name: /Daco platform/ }).click()
    await expect(page).toHaveURL(/\/tickets\/board/)
  })

  test('CO-20 a project row has a Timesheet button that opens the timesheet for that project (v5)', async ({ page }) => {
    await openCompany(page, 'daco')
    await page.getByRole('main').getByRole('link', { name: 'Timesheet', exact: true }).first().click()
    await expect(page).toHaveURL(/\/timesheet\?project=dacop&name=Daco(\+|%20)platform/)
    await expect(page.getByRole('heading', { name: 'Timesheets · Daco platform' })).toBeVisible()
  })

  test('CO-19 edits company notes from Edit and shows them under About', async ({ page }) => {
    await openCompany(page, 'hav')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit company' })
    await dialog.getByLabel('Notes', { exact: true }).fill('Kickoff moved to January.')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
    await expect(panel(page, 'About').getByText('Kickoff moved to January.')).toBeVisible()

    await page.reload()
    await expect(panel(page, 'About').getByText('Kickoff moved to January.')).toBeVisible()
  })
})

test.describe('Projects', () => {
  test('PR-01 switches between Cards and List views', async ({ page }) => {
    await openProjects(page)
    // v5: 10 client projects of the DevOps board's clients join the seed.
    await expect(page.getByText('16 projects · 10 active')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toBeVisible()

    await page.getByRole('button', { name: 'List', exact: true }).click()
    const table = page.getByRole('table')
    await expect(table.getByRole('columnheader', { name: 'Project' })).toBeVisible()
    await expect(table.getByRole('link', { name: 'Daco platform', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toBeVisible()
  })

  test('PR-01 KPI cards show active, client, internal and overdue counts', async ({ page }) => {
    await openProjects(page)
    const kpi = (label: string) => page.locator('dl').first().locator('div').filter({ hasText: label })
    await expect(kpi('Active projects').locator('dd')).toHaveText('10')
    await expect(kpi('Client projects').locator('dd')).toHaveText('13')
    await expect(kpi('Internal projects').locator('dd')).toHaveText('3')
    await expect(kpi('Overdue').locator('dd')).toHaveText('1')
  })

  test('PR-20 a project card has a Timesheet button that opens the timesheet for that project (v5)', async ({ page }) => {
    await openProjects(page)
    const card = page.locator('article').filter({ has: page.getByRole('link', { name: 'Open DevOps board' }) })
    await card.getByRole('link', { name: 'Timesheet', exact: true }).click()
    await expect(page).toHaveURL(/\/timesheet\?project=i1&name=DevOps(\+|%20)board/)
    await expect(page.getByRole('heading', { name: 'Timesheets · DevOps board' })).toBeVisible()
  })

  test('PR-21 ?q= pre-fills the project search (the DevOps board link)', async ({ page }) => {
    await signIn(page, 'super')
    await page.goto('/projects?q=Fast')
    await expect(page.getByRole('link', { name: 'Open Fast' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toHaveCount(0)
  })

  test('PR-02 filters the board by Client and Internal kind', async ({ page }) => {
    await openProjects(page)
    const kindTabs = page.getByRole('navigation', { name: 'Filter by kind' })

    await kindTabs.getByRole('button', { name: /^Client/ }).click()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open DevOps board' })).toHaveCount(0)

    await kindTabs.getByRole('button', { name: /^Internal/ }).click()
    await expect(page.getByRole('link', { name: 'Open DevOps board' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toHaveCount(0)

    await kindTabs.getByRole('button', { name: /^All/ }).click()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open DevOps board' })).toBeVisible()
  })

  test('PR-03 filters by status, including On hold', async ({ page }) => {
    await openProjects(page)
    const status = page.getByRole('combobox', { name: 'Status' })
    await expect(status.locator('option')).toHaveText(['Any status', 'Active', 'Planned', 'On hold', 'Maintenance', 'Completed'])

    // v4 design: the Driver app is in Maintenance; Completed holds the shared CI/CD templates.
    await status.selectOption('maint')
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toHaveCount(0)
    await expect(page.getByText('Support until 30 Aug 2027').first()).toBeVisible()
    await expect(page.getByText('6h of 10h used this month')).toBeVisible()

    await status.selectOption('done')
    await expect(page.getByRole('link', { name: 'Open Shared CI/CD templates' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toHaveCount(0)
    await expect(page.getByText('Completed 20 Sep')).toBeVisible()

    await status.selectOption('hold')
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toHaveCount(0)
    await expect(page.getByText('No projects', { exact: true }).first()).toBeVisible()
  })

  test('PR-04 search matches project name, company name and area', async ({ page }) => {
    await openProjects(page)
    const search = page.getByPlaceholder('Search projects, companies, areas')

    await search.fill('Fjordline')
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toHaveCount(0)

    await search.fill('Website & marketing')
    await expect(page.getByRole('link', { name: 'Open Viljetech website' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toHaveCount(0)
  })

  test('PR-04 developer sees only the projects they are on, under My projects', async ({ page }) => {
    await openProjects(page, 'dev')
    await expect(page.getByRole('link', { name: 'Open Daco platform' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Driver app' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Open DevOps board' })).toHaveCount(0)
  })

  test('PR-05 New project opens the dialog as a client project with today as start date', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await expect(dialog.getByRole('radio', { name: /Client project/ })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByRole('button', { name: 'Choose a company' })).toBeVisible()
    await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue(TODAY)
  })

  test('PR-06 "+" on the Planned column starts with an empty start date and creates a planned project', async ({ page }) => {
    await openProjects(page)
    await page.getByRole('button', { name: 'New project in Planned' }).click()
    const dialog = page.getByRole('dialog', { name: 'Start a new project' })
    await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue('')

    await dialog.getByRole('radio', { name: /Internal project/ }).click()
    await dialog.getByLabel('Project name *').fill('Sensor feed spike')
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('region', { name: 'Planned column' }).getByRole('link', { name: 'Open Sensor feed spike' })).toBeVisible()
  })

  test('PR-06 "+" on the Active column starts with today as start date', async ({ page }) => {
    await openProjects(page)
    await page.getByRole('button', { name: 'New project in Active' }).click()
    const dialog = page.getByRole('dialog', { name: 'Start a new project' })
    await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue(TODAY)
  })

  test('PR-07 chooses a client company from the searchable picker', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('button', { name: 'Choose a company' }).click()
    await dialog.getByRole('searchbox', { name: 'Search companies' }).fill('Nord')
    await dialog.getByRole('button', { name: /Nordlys Energi/ }).click()
    await expect(dialog.getByRole('button', { name: /Nordlys Energi/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Choose a company' })).toHaveCount(0)
  })

  test('PR-08 adds a company inline from the picker and it appears on Companies', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('button', { name: 'Choose a company' }).click()
    await dialog.getByRole('searchbox', { name: 'Search companies' }).fill('Harbor Labs')
    await dialog.getByRole('button', { name: /\+ Add new company/ }).click()

    await expect(dialog.getByLabel('Company name', { exact: true })).toHaveValue('Harbor Labs')
    await dialog.getByLabel('Company name', { exact: true }).fill('')
    await dialog.getByRole('button', { name: 'Add company' }).click()
    await expect(dialog.getByRole('status').filter({ hasText: 'Add a company name' })).toBeVisible()
    await dialog.getByLabel('Company name', { exact: true }).fill('Harbor Labs')
    await dialog.getByLabel('Industry', { exact: true }).fill('Software')
    await dialog.getByRole('button', { name: 'Add company' }).click()
    await expect(dialog.getByRole('button', { name: /Harbor Labs/ })).toBeVisible()

    await dialog.getByLabel('Project name *').fill('Harbor app')
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()

    await page.goto('/companies')
    await expect(page.getByRole('link', { name: /^Harbor Labs/ })).toBeVisible()
  })

  test('PR-09 chooses an internal area', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('radio', { name: /Internal project/ }).click()
    const area = dialog.getByRole('combobox', { name: /^Area/ })
    const options = await area.locator('option').allTextContents()
    expect(options).toEqual(['Platform & tooling', 'Infrastructure', 'Website & marketing', 'Design system', 'Operations', 'Research'])
    await area.selectOption('Design system')
    await expect(area).toHaveValue('Design system')
  })

  test('PR-09 an internal project created with an area is listed under that area', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('radio', { name: /Internal project/ }).click()
    await dialog.getByRole('combobox', { name: /^Area/ }).selectOption('Design system')
    await dialog.getByLabel('Project name *').fill('Icon library')
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: 'Open Icon library' })).toBeVisible()
    await expect(page.getByText('Design system', { exact: true }).first()).toBeVisible()
  })

  test('PR-10 creates a client project under a company and shows it on the company', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('button', { name: 'Choose a company' }).click()
    await dialog.getByRole('searchbox', { name: 'Search companies' }).fill('Nordlys')
    await dialog.getByRole('button', { name: /Nordlys Energi/ }).click()
    await dialog.getByLabel('Project name *').fill('Metering API')
    await dialog.getByLabel('What are we building?').fill('Meter data API for the portal.')
    await dialog.getByLabel('Deadline', { exact: true }).fill('2026-12-31')
    await dialog.getByRole('group', { name: 'Team', exact: true }).getByRole('button', { name: /Chary/ }).click()
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: 'Open Metering API' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('link', { name: 'Open Metering API' })).toBeVisible()

    await page.goto('/companies/nord')
    await expect(page.getByRole('link', { name: /Metering API/ })).toBeVisible()
  })

  test('PR-11 creates an internal project and keeps it after reload', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByRole('radio', { name: /Internal project/ }).click()
    await dialog.getByRole('combobox', { name: /^Area/ }).selectOption('Infrastructure')
    await dialog.getByLabel('Project name *').fill('Backup runbook')
    await dialog.getByRole('button', { name: 'Start project' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: 'Open Backup runbook' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('link', { name: 'Open Backup runbook' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Active column' }).getByText('Infrastructure').first()).toBeVisible()
  })

  test('PR-12 Cancel closes the dialog without creating a project', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    await dialog.getByLabel('Project name *').fill('Discarded idea')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: 'Open Discarded idea' })).toHaveCount(0)

    const reopened = await openNewProjectDialog(page)
    await expect(reopened.getByLabel('Project name *')).toHaveValue('')
  })

  test('PR-13 toggles a team member chip on and off', async ({ page }) => {
    await openProjects(page)
    const dialog = await openNewProjectDialog(page)
    const rahul = dialog.getByRole('group', { name: 'Team', exact: true }).getByRole('button', { name: /Rahul/ })
    await expect(rahul).toHaveAttribute('aria-pressed', 'false')
    await rahul.click()
    await expect(rahul).toHaveAttribute('aria-pressed', 'true')
    await rahul.click()
    await expect(rahul).toHaveAttribute('aria-pressed', 'false')
  })

  test('PR-14 opening a project goes to its tickets board', async ({ page }) => {
    await openProjects(page)
    await page.getByRole('link', { name: 'Open Daco platform' }).click()
    await expect(page).toHaveURL(/\/tickets\/board/)
  })
})
