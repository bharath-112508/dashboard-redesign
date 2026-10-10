import { expect, type Locator, type Page } from '@playwright/test'

/** The project panel (?project=OPS-n) and the windows opened on the DevOps board. */
export const panelOf = (page: Page) => page.getByTestId('project-panel')
export const statusModal = (page: Page) => page.getByTestId('status-modal')
export const settingsOf = (page: Page) => page.getByTestId('settings')
export const cardsOn = (page: Page) => page.locator('[data-card]')

/** Opens the board with a project panel open on the given tab (follow-ups when omitted). */
export async function openProject(page: Page, key: string, tab?: string) {
  await page.goto(`/devops/board?project=${key}${tab ? `&tab=${tab}` : ''}`)
  await expect(panelOf(page)).toBeVisible()
}

/** Switches to a tab of the open project panel (Follow-ups, Phases, Activity, Tickets, Client chat). */
export async function openPanelTab(page: Page, label: string) {
  await panelOf(page).getByRole('button', { name: new RegExp(`^${label}`) }).first().click()
}

/** Moves a client follow-up step: "What happened?" note and next reminder, then the move button. */
export async function moveClientStep(page: Page, label: string, note: string, reminder: string) {
  const panel = panelOf(page)
  await panel.getByRole('button', { name: `Move to ${label}`, exact: true }).click()
  await panel.getByPlaceholder('e.g. Sent second reminder, no reply from client').fill(note)
  await panel.locator('label', { hasText: 'Next reminder' }).locator('input').fill(reminder)
  await panel.getByRole('button', { name: `Move to ${label}`, exact: true }).click()
}

/** Picks a status from the status card menu of the open project panel. */
export async function pickStatus(page: Page, status: string) {
  const panel = panelOf(page)
  await panel.getByTestId('status-change').click()
  await page.getByRole('button', { name: new RegExp(`^${status}`) }).click()
}

/** A text input inside the settings dialog whose current value is `value` (React mirrors it to the value attribute). */
export const settingsInput = (page: Page, value: string): Locator => settingsOf(page).locator(`input[value="${value}"]`)

/** The settings row (name input + hours/days input) whose name input shows `name`. */
export function settingsRow(page: Page, name: string): Locator {
  return settingsOf(page)
    .locator('div')
    .filter({ has: settingsInput(page, name) })
    .filter({ has: settingsOf(page).locator('input[type="number"]') })
    .last()
}

/** Opens a settings tab by URL (?settings=infra|seq|dates|dev). */
export async function openSettings(page: Page, tab: string) {
  await page.goto(`/devops/board?settings=${tab}`)
  await expect(settingsOf(page)).toBeVisible()
}

/** Dismisses the top window with Escape, as a user does. */
export const pressEscape = (page: Page) => page.keyboard.press('Escape')
