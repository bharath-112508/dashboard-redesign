import { test, expect } from '@playwright/test'
import { signIn, USERS, type Role } from './helpers/session'
import {
  EXPECTED_NAV,
  clickNav,
  loginWith,
  mainNav,
  openProfile,
  profileDialog,
  readStoredSession,
  search,
  searchBox,
  sidebar,
  signOutFromSidebar,
} from './helpers/shell'

const BACK = { name: 'Back', exact: true } as const
const BAD_PASSWORD_MESSAGE = 'That password is not right.'

test.describe('Login (01-login.md)', () => {
  test('LG-01 signs in with email and the demo password and lands on Dashboard', async ({ page }) => {
    await signIn(page, 'super')
    await expect(page).toHaveURL(/\/dashboard$/)
    expect(await readStoredSession(page)).toMatchObject({ name: 'Rahul', email: USERS.super, role: 'super', org: 'Viljetech' })
  })

  test('LG-01 accepts the sign-in when the email has different case and surrounding spaces', async ({ page }) => {
    await loginWith(page, '  LARS@DACO.NO ', 'demo')
    await expect(page).toHaveURL(/\/dashboard$/)
    expect(await readStoredSession(page)).toMatchObject({ email: 'lars@daco.no', role: 'cuser', orgId: 'daco' })
  })

  test('LG-01 submits with the Enter key from the password field', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('name@company.com').fill(USERS.dev)
    await page.getByPlaceholder('••••••••').fill('demo')
    await page.getByPlaceholder('••••••••').press('Enter')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('LG-01 refuses a wrong password (spec hint says any password works; spec bug 1 says production must not copy that)', async ({ page }) => {
    await loginWith(page, USERS.super, 'not-the-password')
    await expect(page.getByRole('alert')).toHaveText(BAD_PASSWORD_MESSAGE)
    await expect(page).toHaveURL(/\/login$/)
  })

  test('LG-01 removes the legacy vt.dashRole key on sign-in (spec data effect)', async ({ page }) => {
    await page.goto('/login')
    await page.evaluate(() => localStorage.setItem('vt.dashRole', 'dev'))
    await page.reload()
    await loginWith(page, USERS.super, 'demo')
    await expect(page).toHaveURL(/\/dashboard$/)
    expect(await page.evaluate(() => localStorage.getItem('vt.dashRole'))).toBeNull()
  })

  test('LG-02 clicking a sample user fills the email and password and highlights the row', async ({ page }) => {
    await page.goto('/login')
    const row = page.getByRole('button', { name: /Lars Moen/ })
    await row.click()
    await expect(page.getByPlaceholder('name@company.com')).toHaveValue('lars@daco.no')
    await expect(page.getByPlaceholder('••••••••')).toHaveValue('demo')
    await expect(page.getByPlaceholder('••••••••')).toHaveAttribute('type', 'password')
    await expect(row).toHaveCSS('background-color', 'rgb(242, 246, 254)')
  })

  test('LG-02 clicking a sample user clears an error that was showing', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter your email.')
    await page.getByRole('button', { name: /Chary/ }).click()
    await expect(page.getByRole('alert')).toBeHidden()
  })

  test('LG-03 unknown email shows the no-user message and does not sign in', async ({ page }) => {
    await loginWith(page, 'nobody@example.com', 'demo')
    await expect(page.getByRole('alert')).toHaveText('No user with that email. Pick a sample user on the right.')
    await expect(page).toHaveURL(/\/login$/)
    expect(await readStoredSession(page)).toBeNull()
  })

  test('LG-04 empty email shows "Enter your email." and does not sign in', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter your email.')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('LG-05 "Continue ›" goes to Dashboard for a user who is already signed in', async ({ page }) => {
    await signIn(page, 'pm')
    await page.goto('/login')
    await expect(page.getByText('Signed in as')).toBeVisible()
    await expect(page.locator('b', { hasText: 'Bhavana P' })).toBeVisible()
    await page.getByRole('link', { name: 'Continue ›' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('LG-06 typing in the email field clears the error', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter your email.')
    await page.getByPlaceholder('name@company.com').fill('r')
    await expect(page.getByRole('alert')).toBeHidden()
  })
})

test.describe('App shell (00-shell.md)', () => {
  test('SH-01 sidebar shows exactly the items the role may open (matrix in spec)', async ({ page }) => {
    const roles = Object.keys(EXPECTED_NAV) as Role[]
    for (const role of roles) {
      await signIn(page, role)
      const labels = await mainNav(page).getByRole('link').allInnerTexts()
      expect(labels.map(l => l.trim()), `sidebar for ${role}`).toEqual(EXPECTED_NAV[role])
      await page.evaluate(() => localStorage.clear())
    }
  })

  test('SH-01 clicking a sidebar item switches the page, updates the URL and highlights the item', async ({ page }) => {
    await signIn(page, 'super')
    await clickNav(page, 'Companies')
    await expect(page).toHaveURL(/\/companies$/)
    const link = mainNav(page).getByRole('link', { name: 'Companies', exact: true })
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expect(link).toHaveCSS('background-color', 'rgb(27, 45, 69)')
    await expect(mainNav(page).getByRole('link', { name: 'Dashboard', exact: true })).not.toHaveAttribute('aria-current', 'page')
  })

  test('SH-02 "Collapse" narrows the sidebar to 60px and "Expand" restores 232px', async ({ page }) => {
    await signIn(page, 'super')
    await expect(sidebar(page)).toHaveCSS('width', '232px')
    await page.getByRole('button', { name: 'Collapse menu' }).click()
    await expect(sidebar(page)).toHaveCSS('width', '60px')
    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible()
    await expect(mainNav(page).getByRole('link', { name: 'Companies', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Expand menu' }).click()
    await expect(sidebar(page)).toHaveCSS('width', '232px')
    await expect(mainNav(page).getByRole('link', { name: 'Companies', exact: true })).toBeVisible()
  })

  test('SH-02 the collapsed state is remembered after reload (vt.sideCol)', async ({ page }) => {
    await signIn(page, 'super')
    await page.getByRole('button', { name: 'Collapse menu' }).click()
    await expect(sidebar(page)).toHaveCSS('width', '60px')
    expect(await page.evaluate(() => localStorage.getItem('vt.sideCol'))).toBe('1')
    await page.reload()
    await expect(sidebar(page)).toHaveCSS('width', '60px')
  })

  test('SH-03 empty search shows the hint; a query lists matching pages', async ({ page }) => {
    await signIn(page, 'super')
    await searchBox(page).click()
    await expect(page.getByText('Search pages, tickets, projects, companies and people.')).toBeVisible()
    const results = await search(page, 'Dash')
    await expect(results.getByText('Pages', { exact: true })).toBeVisible()
    await expect(results.getByRole('option', { name: /^Dashboard/ })).toBeVisible()
  })

  test('SH-03 results are grouped by Projects, Companies and People for a matching term', async ({ page }) => {
    await signIn(page, 'super')
    const results = await search(page, 'Daco')
    await expect(results.getByText('Companies', { exact: true })).toBeVisible()
    await expect(results.getByRole('option', { name: /^Daco/ }).first()).toBeVisible()
    await search(page, 'Daco platform')
    await expect(results.getByText('Projects', { exact: true })).toBeVisible()
    await search(page, 'Chary')
    await expect(results.getByText('People', { exact: true })).toBeVisible()
  })

  test('SH-03 a term with no match shows "No results for"', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'zzqxnothing')
    await expect(page.getByText('No results for “zzqxnothing”')).toBeVisible()
  })

  test('SH-03 search only lists groups the role may open (client user sees no Daco company or people)', async ({ page }) => {
    await signIn(page, 'cuser')
    await search(page, 'Daco')
    await expect(page.getByText('No results for “Daco”')).toBeVisible()
  })

  test('SH-03 Escape clears the search and closes the results', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'Dash')
    await searchBox(page).press('Escape')
    await expect(page.getByRole('listbox', { name: 'Search results' })).toBeHidden()
    await expect(searchBox(page)).toHaveValue('')
  })

  test('SH-03 Enter opens the first result', async ({ page }) => {
    await signIn(page, 'super')
    await clickNav(page, 'Companies')
    await search(page, 'Dash')
    await searchBox(page).press('Enter')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-04 opening a page result navigates to that page', async ({ page }) => {
    await signIn(page, 'super')
    await clickNav(page, 'Companies')
    await search(page, 'Dash')
    await page.getByRole('option', { name: /^Dashboard/ }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-04 opening a ticket result goes to the Tickets page with that ticket', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'Link tickets')
    await page.getByRole('option', { name: /Link tickets to the DevOps board/ }).click()
    await expect(page).toHaveURL(/\/tickets\/board\?ticket=4$/)
  })

  test('SH-04 opening a project result goes to Projects', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'Daco platform')
    await page.getByRole('option', { name: /^Daco platform/ }).click()
    await expect(page).toHaveURL(/\/projects$/)
  })

  test('SH-04 opening a company result goes to Companies', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'Nordlys')
    await page.getByRole('option', { name: /^Nordlys Energi/ }).click()
    await expect(page).toHaveURL(/\/companies$/)
  })

  test('SH-04 opening a person result goes to Users', async ({ page }) => {
    await signIn(page, 'super')
    await search(page, 'Sofia')
    await page.getByRole('option', { name: /^Sofia/ }).click()
    await expect(page).toHaveURL(/\/users$/)
  })

  test('SH-05 Back is disabled with no history and returns to the previous page once navigated', async ({ page }) => {
    await signIn(page, 'super')
    const back = page.getByRole('button', BACK)
    await expect(back).toBeDisabled()
    await clickNav(page, 'Companies')
    await expect(back).toBeEnabled()
    await back.click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(back).toBeDisabled()
  })

  test('SH-05 Back is not shown on the Clients page, which carries its own back link', async ({ page }) => {
    await signIn(page, 'super')
    await page.goto('/clients/board')
    await expect(page.locator('button[title^="Back"]')).toHaveCount(0)
  })

  test('SH-06 the sidebar profile row opens Profile settings with the session draft', async ({ page }) => {
    await signIn(page, 'pm')
    await openProfile(page)
    const dialog = profileDialog(page)
    await expect(dialog.getByText('Profile settings', { exact: true })).toBeVisible()
    await expect(dialog.getByLabel('Full name')).toHaveValue('Bhavana P')
    await expect(dialog.getByLabel('Email')).toHaveValue(USERS.pm)
    await expect(dialog.getByLabel('Email')).toHaveAttribute('readonly', '')
  })

  test('SH-07 editing name, phone and time zone updates the draft fields', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('Full name').fill('Chary K')
    await dialog.getByLabel('Phone').fill('+47 900 00 000')
    await dialog.getByLabel('Time zone').selectOption('Asia/Kolkata')
    await expect(dialog.getByLabel('Full name')).toHaveValue('Chary K')
    await expect(dialog.getByLabel('Phone')).toHaveValue('+47 900 00 000')
    await expect(dialog.getByLabel('Time zone')).toHaveValue('Asia/Kolkata')
  })

  test('SH-07 an empty name shows "Add your name" and the message clears once corrected', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('Full name').fill('   ')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Add your name')
    await dialog.getByLabel('Full name').fill('Chary')
    await expect(dialog.getByRole('status')).toHaveText('')
  })

  test('SH-08 a notification switch toggles and the choice is kept after saving', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    const due = dialog.getByRole('switch', { name: /Due date reminders/ })
    await expect(due).toHaveAttribute('aria-checked', 'true')
    await due.click()
    await expect(due).toHaveAttribute('aria-checked', 'false')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(profileDialog(page)).toBeHidden()
    await openProfile(page)
    await expect(profileDialog(page).getByRole('switch', { name: /Due date reminders/ })).toHaveAttribute('aria-checked', 'false')
  })

  test('SH-09 password fields are validated: mismatch and too short', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('New password', { exact: true }).fill('abcdefgh')
    await dialog.getByLabel('Repeat password').fill('abcdefgX')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Passwords do not match')

    await dialog.getByLabel('New password', { exact: true }).fill('abc')
    await dialog.getByLabel('Repeat password').fill('abc')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Password needs at least 8 characters')
    await expect(dialog).toBeVisible()
  })

  test('SH-09 a valid new password closes the modal and is the one that signs in afterwards', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('New password', { exact: true }).fill('newpass123')
    await dialog.getByLabel('Repeat password').fill('newpass123')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(profileDialog(page)).toBeHidden()

    await signOutFromSidebar(page)
    await expect(page).toHaveURL(/\/login$/)
    await loginWith(page, USERS.dev, 'demo')
    await expect(page.getByRole('alert')).toHaveText(BAD_PASSWORD_MESSAGE)
    await loginWith(page, USERS.dev, 'newpass123')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-09 an empty name blocks the save even when passwords are valid', async ({ page }) => {
    await signIn(page, 'dev')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('Full name').fill('')
    await dialog.getByLabel('New password', { exact: true }).fill('newpass123')
    await dialog.getByLabel('Repeat password').fill('newpass123')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Add your name')
    await expect(dialog).toBeVisible()
  })

  test('SH-10 saving the profile updates the sidebar name and the stored session', async ({ page }) => {
    await signIn(page, 'super')
    await openProfile(page)
    const dialog = profileDialog(page)
    await dialog.getByLabel('Full name').fill('Rahul Kumar')
    await dialog.getByLabel('Phone').fill('+47 111 22 333')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(profileDialog(page)).toBeHidden()
    await expect(sidebar(page).getByText('Rahul Kumar', { exact: true })).toBeVisible()
    await expect.poll(() => readStoredSession(page)).toMatchObject({ name: 'Rahul Kumar', phone: '+47 111 22 333' })
    await page.reload()
    await expect(sidebar(page).getByText('Rahul Kumar', { exact: true })).toBeVisible()
  })

  test('SH-10 a saved name is also shown in the Users list (directory agrees with the header)', async ({ page }) => {
    await signIn(page, 'super')
    await openProfile(page)
    await profileDialog(page).getByLabel('Full name').fill('Rahul Kumar')
    await profileDialog(page).getByRole('button', { name: 'Save changes' }).click()
    await expect(profileDialog(page)).toBeHidden()
    await clickNav(page, 'Users')
    await expect(page.getByText('Rahul Kumar', { exact: true }).first()).toBeVisible()
  })

  test('SH-11 Cancel closes the modal and discards the draft', async ({ page }) => {
    await signIn(page, 'pm')
    await openProfile(page)
    await profileDialog(page).getByLabel('Full name').fill('Someone Else')
    await profileDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(profileDialog(page)).toBeHidden()
    await expect(sidebar(page).getByText('Bhavana P', { exact: true })).toBeVisible()
    await openProfile(page)
    await expect(profileDialog(page).getByLabel('Full name')).toHaveValue('Bhavana P')
  })

  test('SH-11 the close button (x) and a click on the backdrop also close the modal', async ({ page }) => {
    await signIn(page, 'pm')
    await openProfile(page)
    await profileDialog(page).getByRole('button', { name: 'Close' }).click()
    await expect(profileDialog(page)).toBeHidden()
    await openProfile(page)
    await page.mouse.click(10, 880)
    await expect(profileDialog(page)).toBeHidden()
  })

  test('SH-12 Sign out returns to Login and the session is removed', async ({ page }) => {
    await signIn(page, 'admin')
    await signOutFromSidebar(page)
    await expect(page).toHaveURL(/\/login$/)
    expect(await readStoredSession(page)).toBeNull()
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login$/)
  })

  test.skip('SH-13 SKIPPED, not built: header avatar menu exists only on non-shell pages in the spec, and the build shell has no header user menu', async () => {})

  test('SH-14 a role without access is sent to Dashboard with the access-denied message', async ({ page }) => {
    await signIn(page, 'cuser')
    await page.goto('/companies')
    await expect(page.getByRole('status')).toHaveText('Your role (Client user) does not have access to Companies')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-14 the access-denied message hides after a few seconds', async ({ page }) => {
    await signIn(page, 'pm')
    await page.goto('/users')
    await expect(page.getByRole('status')).toContainText('does not have access to Users')
    await expect(page.getByRole('status')).toBeHidden({ timeout: 5_000 })
  })

  test('SH-14 a developer opening the DevOps board is refused', async ({ page }) => {
    await signIn(page, 'dev')
    await page.goto('/devops/board')
    await expect(page.getByRole('status')).toHaveText('Your role (Developer) does not have access to DevOps Board')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-15 a hash deep link such as #Companies opens that page', async ({ page }) => {
    await signIn(page, 'super')
    await page.goto('/dashboard')
    await page.goto('/#Companies')
    await expect(page).toHaveURL(/\/companies$/)
  })

  test('SH-15 an unknown hash name falls back to Dashboard', async ({ page }) => {
    await signIn(page, 'super')
    await page.goto('/#NoSuchPage')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('SH-15 a hash deep link to a page the role cannot open is refused', async ({ page }) => {
    await signIn(page, 'cuser')
    await page.goto('/#Companies')
    await expect(page.getByRole('status')).toContainText('does not have access to Companies')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('client chrome: the Daco admin sees the org name and "admin panel" in the brand, with Project portal', async ({ page }) => {
    await signIn(page, 'cadmin')
    await expect(sidebar(page).getByText('Daco admin panel', { exact: true })).toBeVisible()
    await expect(sidebar(page).getByText('Powered by Viljetech')).toBeVisible()
  })

  test('client chrome: the Daco client user sees the project portal name (spec bug 4 says "admin panel" is wrong for them)', async ({ page }) => {
    await signIn(page, 'cuser')
    await expect(sidebar(page).getByText('Daco project portal', { exact: true })).toBeVisible()
  })

  test('brand: internal users see the Viljetech name in the sidebar', async ({ page }) => {
    await signIn(page, 'super')
    await expect(sidebar(page).getByText('Viljetech', { exact: true })).toBeVisible()
  })
})
