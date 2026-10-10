import { expect, type Page } from '@playwright/test'
import { USERS, type Role } from './session'

/** Signs in with any email and password through the sign-in form. Resolves once the URL leaves /login. */
export async function loginWith(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByPlaceholder('name@company.com').fill(email)
  await page.getByPlaceholder('••••••••').fill(password)
  await page.locator('button[type="submit"]').click()
}

/** The sidebar root (the element whose width collapses). */
export const sidebar = (page: Page) => page.locator('[data-sidebar]')

/** The main navigation landmark. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })

/** Clicks a sidebar item by its visible label. */
export async function clickNav(page: Page, label: string) {
  await mainNav(page).getByRole('link', { name: label, exact: true }).click()
}

/** The global search box in the top bar. */
export const searchBox = (page: Page) => page.getByRole('searchbox', { name: /Search pages, tickets/ })

/** Types into the global search and returns the results listbox. */
export async function search(page: Page, term: string) {
  await searchBox(page).fill(term)
  return page.getByRole('listbox', { name: 'Search results' })
}

/** The profile settings dialog. */
export const profileDialog = (page: Page) => page.getByRole('dialog')

/** Opens the profile settings dialog from the sidebar footer. */
export async function openProfile(page: Page) {
  await sidebar(page).locator('button[title="Profile settings"]').click()
  await expect(profileDialog(page)).toBeVisible()
}

/** Signs out from the sidebar. */
export async function signOutFromSidebar(page: Page) {
  await sidebar(page).getByRole('button', { name: 'Sign out' }).click()
}

/** Reads a value from the signed-in session in localStorage. */
export async function readStoredSession(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('vt.session')
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  })
}

/** Sidebar item labels a role should see, from the sidebar matrix in 00-shell.md. */
export const EXPECTED_NAV: Record<Role, string[]> = {
  super: ['Dashboard', 'Companies', 'Projects', 'DevOps board', 'My tickets', 'Clients', 'Timesheet', 'Employee timesheets', 'Users'],
  admin: ['Dashboard', 'Companies', 'Projects', 'DevOps board', 'My tickets', 'Clients', 'Timesheet', 'Employee timesheets', 'Users'],
  pm: ['Dashboard', 'Companies', 'Projects', 'My tickets', 'Clients', 'Timesheet', 'Employee timesheets'],
  dev: ['Dashboard', 'Companies', 'Projects', 'My tickets', 'Timesheet'],
  devops: ['Dashboard', 'DevOps board', 'Timesheet'],
  cadmin: ['Dashboard', 'Project portal', 'Users'],
  cuser: ['Dashboard', 'Project portal'],
}

export { USERS }
