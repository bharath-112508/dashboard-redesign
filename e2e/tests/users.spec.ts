import { test, expect, type Page } from '@playwright/test'
import { signIn } from './helpers/session'
import { PNG_1PX, storedDb } from './helpers/people-time'

const table = (page: Page) => page.getByRole('table', { name: 'Users' })
const row = (page: Page, name: string) => table(page).getByRole('row').filter({ hasText: name })

async function openUsers(page: Page, role: 'super' | 'admin' | 'cadmin' = 'super', query = '') {
  await signIn(page, role)
  await page.goto(`/users${query}`)
}

/** Opens the Edit dialog for a person from the Users table. */
async function openEdit(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

/** Fills the new-user basics and sends the invite. */
async function inviteUser(page: Page, name: string, email: string) {
  await page.getByRole('button', { name: 'Add user', exact: true }).click()
  await page.getByRole('textbox', { name: /^Full name \*/ }).fill(name)
  await page.getByRole('textbox', { name: /^Email \*/ }).fill(email)
  await page.getByRole('button', { name: 'Send invite', exact: true }).click()
}

test.describe('Users', () => {
  test('US-01 search matches name or email, and shows an empty state', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('searchbox', { name: 'Search users' }).fill('Chary')
    await expect(row(page, 'Chary')).toHaveCount(1)
    await expect(table(page)).not.toContainText('Vivek')

    await page.getByRole('searchbox', { name: 'Search users' }).fill('lars@daco.no')
    await expect(row(page, 'Lars Moen')).toHaveCount(1)
    await expect(table(page)).not.toContainText('Chary')

    await page.getByRole('searchbox', { name: 'Search users' }).fill('zzz-no-match')
    await expect(page.getByText('No users match these filters.')).toBeVisible()
  })

  test('US-02 role filter narrows the list to one role', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('combobox', { name: 'Filter by role' }).selectOption({ label: 'Developer' })
    await expect(row(page, 'Chary')).toHaveCount(1)
    await expect(row(page, 'Bharath Reddy Panyala')).toHaveCount(1)
    await expect(table(page)).not.toContainText('Vivek')
    await expect(table(page)).not.toContainText('Rahul')
  })

  test('US-03 company filter shows only people of that company', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('combobox', { name: 'Filter by company' }).selectOption({ label: 'Daco' })
    await expect(row(page, 'Lars Moen')).toHaveCount(1)
    await expect(row(page, 'Ingrid Solberg')).toHaveCount(1)
    await expect(table(page)).not.toContainText('Chary')
  })

  test('US-04 Add user: invites a person with the chosen access, and it persists', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('button', { name: 'Add user', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a user' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: /^Full name \*/ }).fill('Test Person')
    await dialog.getByRole('textbox', { name: /^Email \*/ }).fill('test.person@viljetech.com')
    await dialog.getByRole('combobox', { name: 'User type', exact: true }).selectOption({ label: 'Backend' })
    await dialog.getByLabel('Freelancer').check()
    await dialog.getByLabel('Choose projects').check()
    await dialog.getByRole('button', { name: /Daco platform/ }).click()
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click()

    await expect(page.getByText('Invited Test Person. No email is sent yet.')).toBeVisible()
    await expect(row(page, 'Test Person')).toContainText('Invited')
    await expect(page.getByText(/^Pending invites · 2$/)).toBeVisible()

    await page.reload()
    await expect(row(page, 'Test Person')).toContainText('Invited', { timeout: 8_000 })
    await expect(row(page, 'Test Person')).toContainText('Backend')
  })

  test('US-04 Add user validates name, email and duplicate email', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('button', { name: 'Add user', exact: true }).click()
    await page.getByRole('button', { name: 'Send invite', exact: true }).click()
    await expect(page.getByText('Add a name')).toBeVisible()
    await expect(page.getByText('Enter a valid email')).toBeVisible()

    await page.getByRole('textbox', { name: /^Full name \*/ }).fill('Dup Person')
    await page.getByRole('textbox', { name: /^Email \*/ }).fill('vivek@viljetech.com')
    await page.getByRole('button', { name: 'Send invite', exact: true }).click()
    await expect(page.getByText('Another person already uses this email.')).toBeVisible()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('US-05 client admin adds a colleague to their own company (Daco)', async ({ page }) => {
    await openUsers(page, 'cadmin')
    await expect(page.getByRole('heading', { level: 1, name: 'Colleagues' })).toBeVisible()
    await inviteUser(page, 'Anna Client', 'anna@daco.no')

    await expect(page.getByText('Invited Anna Client. No email is sent yet.')).toBeVisible()
    await expect(row(page, 'Anna Client')).toContainText('Client user')
    await expect(row(page, 'Anna Client')).toContainText('Invited')

    await page.reload()
    await expect(row(page, 'Anna Client')).toBeVisible({ timeout: 8_000 })
  })

  test('US-06 editing a user saves the change and persists', async ({ page }) => {
    await openUsers(page)
    await openEdit(page, 'Chary')
    await expect(page.getByRole('heading', { name: 'Chary' })).toBeVisible()
    await page.getByRole('textbox', { name: /^Full name \*/ }).fill('Chary Kumar')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()

    await expect(page.getByText('Saved Chary Kumar.')).toBeVisible()
    await expect(row(page, 'Chary Kumar')).toHaveCount(1)

    await page.reload()
    await expect(row(page, 'Chary Kumar')).toHaveCount(1, { timeout: 8_000 })
  })

  test('US-07 deactivating a user blocks their sign-in', async ({ page }) => {
    await openUsers(page)
    await openEdit(page, 'Chary')
    const toggle = page.getByRole('switch', { name: 'Account active' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(row(page, 'Chary')).toContainText('Deactivated')
    // The row updates before the mock backend commits; leave the page only once the change is stored.
    await expect.poll(async () => (await storedDb(page)).people?.find(p => p.name === 'Chary')?.active).toBe(false)

    await page.goto('/login')
    await page.getByPlaceholder('name@company.com').fill('chary@viljetech.com')
    await page.getByPlaceholder('••••••••').fill('demo')
    await page.locator('button[type="submit"]').click()
    await expect(page.getByText('This account is deactivated. Ask an admin to reactivate it.')).toBeVisible()
  })

  test('US-08 remove user asks for confirmation, and removes the row after confirming', async ({ page }) => {
    await openUsers(page)
    await openEdit(page, 'Chary')
    await page.getByRole('button', { name: 'Remove user', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Remove Chary?' })
    await expect(confirm).toBeVisible()

    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible()
    await expect(row(page, 'Chary')).toHaveCount(1)

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await openEdit(page, 'Chary')
    await page.getByRole('button', { name: 'Remove user', exact: true }).click()
    await page.getByRole('dialog', { name: 'Remove Chary?' }).getByRole('button', { name: 'Remove user', exact: true }).click()
    await expect(page.getByText(/Removed Chary\./)).toBeVisible()
    await expect(row(page, 'Chary')).toHaveCount(0)

    await page.reload()
    await expect(table(page)).not.toContainText('Chary', { timeout: 8_000 })
  })

  test('US-09 opens a profile from the user row', async ({ page }) => {
    await openUsers(page)
    await row(page, 'Chary').getByRole('link', { name: 'Chary', exact: true }).click()
    await expect(page).toHaveURL(/\/users\/3$/)
    await expect(page.getByRole('link', { name: /Back to Users/ })).toBeVisible()
    await expect(page.getByText('Working on:')).toBeVisible()
  })

  test('US-10 admin edits a role permission in the matrix (Developer loses Create & edit tickets)', async ({ page }) => {
    await openUsers(page, 'admin', '?tab=roles')
    const cell = page.getByRole('button', { name: 'Developer: Create & edit tickets' })
    await expect(cell).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /^Developer Viljetech/ }).getByText('5 of 14 permissions')).toBeVisible()

    await cell.click()
    await expect(cell).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: /^Developer Viljetech/ }).getByText('4 of 14 permissions')).toBeVisible()
  })

  test('US-10 the super admin column is locked', async ({ page }) => {
    await openUsers(page, 'super', '?tab=roles')
    await expect(page.getByLabel('Super admin: Create & edit tickets, always on')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Super admin: Create & edit tickets' })).toHaveCount(0)
  })

  test('US-11 selecting a role card shows that role in the matrix', async ({ page }) => {
    await openUsers(page, 'super', '?tab=roles')
    const card = page.getByRole('button', { name: /^Client admin Client/ })
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Selected: Client admin.')).toBeVisible()
  })

  test('US-12 adds a developer type from the user form, and the user gets it', async ({ page }) => {
    await openUsers(page)
    await page.getByRole('button', { name: 'Add user', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a user' })
    await dialog.getByRole('button', { name: '+ Add', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'New developer type' }).fill('Data Engineer')
    await dialog.getByRole('button', { name: 'Add type', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'User type', exact: true })).toHaveValue('Data Engineer')

    await dialog.getByRole('textbox', { name: /^Full name \*/ }).fill('Dev Typed')
    await dialog.getByRole('textbox', { name: /^Email \*/ }).fill('dev.typed@viljetech.com')
    await dialog.getByRole('button', { name: 'Send invite', exact: true }).click()
    await expect(row(page, 'Dev Typed')).toContainText('Data Engineer')
  })

  test('US-13 uploading a profile photo shows it in the form and the users list', async ({ page }) => {
    await openUsers(page)
    await openEdit(page, 'Chary')
    const dialog = page.getByRole('dialog')
    await page.getByLabel('Change photo', { exact: true }).setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_1PX })
    await expect(dialog.locator('img').first()).toBeVisible()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()

    await expect(page.getByText('Saved Chary.')).toBeVisible()
    await expect(row(page, 'Chary').locator('img')).toHaveCount(1)
    await page.reload()
    await expect(row(page, 'Chary').locator('img')).toHaveCount(1, { timeout: 8_000 })
  })

  test('US-13 rejects a file that is not an image', async ({ page }) => {
    await openUsers(page)
    await openEdit(page, 'Chary')
    await page.getByLabel('Change photo', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByText('Choose an image file.')).toBeVisible()
  })
})
