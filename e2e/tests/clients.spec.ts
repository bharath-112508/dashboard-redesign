import { test, expect, type Page } from '@playwright/test'
import { sendCommand, signIn } from './helpers/session'

/**
 * Clients portal: "Your projects" (portal home), the board, Epics & sprints
 * and the timeline. Flow IDs refer to 05-clients.md (CL-01 to CL-25).
 */

const BUG_TITLE = 'App freezes when I open a task offline'
const QUESTION_TITLE = 'Which languages at launch?'
const TEAM_TASK = 'Offline mode for the task list'

const card = (page: Page, text: string) => page.getByText(text, { exact: false }).first()

/** Waits until the store has been written to localStorage with the given text. */
async function waitSaved(page: Page, text: string) {
  await page.waitForFunction(t => (localStorage.getItem('vt.clients.db') ?? '').includes(t), text, { timeout: 8000 })
}

async function openBoard(page: Page) {
  await page.goto('/clients/board')
  await expect(page.getByRole('heading', { name: 'Project Management tool' })).toBeVisible()
}

async function reportBug(page: Page, title: string, priority: 'Low' | 'Medium' | 'High' | 'Critical' = 'Medium') {
  await page.getByRole('button', { name: 'Report a bug' }).first().click()
  await page.getByPlaceholder('e.g. App crashes when I open a task').fill(title)
  await page.getByRole('button', { name: new RegExp('^' + priority + '\\b') }).click()
  await page.getByRole('button', { name: 'Report bug' }).click()
  await expect(page.getByText('Tell us what went wrong.')).toBeHidden()
}

async function openBug(page: Page, title: string) {
  await card(page, title).click()
  await expect(page.getByRole('button', { name: 'Close' }).first()).toBeVisible()
}

test.describe('Clients portal: Your projects', () => {
  test('CL-01 client admin opens a project from "Your projects" and lands on its board', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/clients')
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible()
    await page.getByRole('article', { name: 'Daco platform' }).getByRole('button', { name: 'Open project ›' }).click()
    await expect(page).toHaveURL(/\/clients\/board/)
    await expect(card(page, 'Login with BankID')).toBeVisible()
  })

  test('CL-01 client user opens a project from "Your projects" and lands on its board', async ({ page }) => {
    await signIn(page, 'cuser')
    await page.goto('/clients')
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible()
    await page.getByRole('article', { name: 'Daco platform' }).getByRole('button', { name: 'Open project ›' }).click()
    await expect(page).toHaveURL(/\/clients\/board/)
    await expect(card(page, 'Login with BankID')).toBeVisible()
  })

  test('CL-02 client user reports a bug and it appears on the board after reload', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await reportBug(page, 'Export button hangs', 'High')
    await expect(card(page, 'Export button hangs')).toBeVisible()
    await waitSaved(page, 'Export button hangs')
    await page.reload()
    await expect(card(page, 'Export button hangs')).toBeVisible()
  })

  test('CL-19 client admin adds a member to "Your team" and the member survives reload', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/clients')
    await page.getByRole('button', { name: 'Add member' }).click()
    await page.getByPlaceholder('e.g. Maria Berg').fill('Maria Berg')
    await page.getByPlaceholder('name@company.com').fill('maria@daco.no')
    await page.getByPlaceholder('e.g. Site manager').fill('Site manager')
    await page.getByRole('button', { name: 'Add to team' }).click()
    await expect(page.getByRole('complementary', { name: 'Your team' }).getByText('Maria Berg')).toBeVisible()
    await waitSaved(page, 'maria@daco.no')
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Your team' }).getByText('Maria Berg')).toBeVisible()
  })

  test('CL-19 client user cannot add members to "Your team"', async ({ page }) => {
    await signIn(page, 'cuser')
    await page.goto('/clients')
    await expect(page.getByRole('heading', { name: 'Your team' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0)
  })

  test('CL-20 client admin removes a team member and the removal survives reload', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/clients')
    await page.getByRole('button', { name: 'Remove Anna Lindqvist' }).click()
    await expect(page.getByText('Anna Lindqvist')).toHaveCount(0)
    // Wait for the stored db itself: before the first write there is none, and that must not count as removed.
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('vt.clients.db')
      return !!raw && !raw.includes('anna@daco.se')
    }, undefined, { timeout: 8000 })
    await page.reload()
    await expect(page.getByText('Anna Lindqvist')).toHaveCount(0)
  })
})

test.describe('Clients portal: board, bugs and questions', () => {
  test('CL-03 client user chats on a bug and the message survives reload', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    await page.getByPlaceholder('Message the team…').fill('Still happening on version 2.1')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Still happening on version 2.1')).toBeVisible()
    await waitSaved(page, 'Still happening on version 2.1')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    await expect(page.getByText('Still happening on version 2.1')).toBeVisible()
  })

  test('CL-04 client user changes the priority of their own bug', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    await page.getByRole('button', { name: 'Critical', exact: true }).click()
    await waitSaved(page, '"prio":"Critical"')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    const saved = await page.evaluate(t => {
      const db = JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}')
      return (db.tasks ?? []).find((x: { title: string }) => x.title === t)?.prio
    }, BUG_TITLE)
    expect(saved).toBe('Critical')
  })

  test('CL-05 client user edits the description of their own bug', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.locator('textarea').first().fill('Freezes every time, even with Wi-Fi on.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Freezes every time, even with Wi-Fi on.').first()).toBeVisible()
    await waitSaved(page, 'Freezes every time, even with Wi-Fi on.')
    await openBoard(page)
    await openBug(page, BUG_TITLE)
    await expect(page.getByText('Freezes every time, even with Wi-Fi on.').first()).toBeVisible()
  })

  test('CL-06 team member raises a question that appears in "Questions to client" on the board', async ({ page }) => {
    await signIn(page, 'pm')
    await page.goto('/tickets/board')
    await page.getByText('Questions to client').first().click()
    await page.getByRole('button', { name: 'Raise a question' }).first().click()
    await page.getByPlaceholder('Title, e.g. Which languages at launch?').fill('Which store accounts should we use?')
    await page.getByPlaceholder('Describe what you need from the client…').fill('We need the developer account owner.')
    await page.getByRole('button', { name: 'Raise question' }).click()
    await waitSaved(page, 'Which store accounts should we use?')
    await openBoard(page)
    await expect(card(page, 'Which store accounts should we use?')).toBeVisible()
  })

  test('CL-07 client user answers a question and the reply survives reload', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await card(page, QUESTION_TITLE).click()
    await page.getByPlaceholder('Write your answer…').fill('Swedish and English.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Swedish and English.').first()).toBeVisible()
    await waitSaved(page, 'Swedish and English.')
    await openBoard(page)
    await card(page, QUESTION_TITLE).click()
    await expect(page.getByText('Swedish and English.').first()).toBeVisible()
  })

  test('CL-08 client user marks a question solved and reopens it', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await card(page, QUESTION_TITLE).click()
    await page.getByRole('button', { name: 'Mark as solved' }).click()
    await expect(page.getByRole('button', { name: 'Solved · reopen' })).toBeVisible()
    await waitSaved(page, 'Marked as solved')
    await page.getByRole('button', { name: 'Solved · reopen' }).click()
    await expect(page.getByRole('button', { name: 'Mark as solved' })).toBeVisible()
    await expect(page.getByText('Reopened the question')).toBeVisible()
  })

  test('CL-09 client user edits their own answer and only the new text shows everywhere', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await card(page, QUESTION_TITLE).click()
    await page.getByPlaceholder('Write your answer…').fill('First draft answer')
    await page.getByRole('button', { name: 'Send' }).click()
    // The answer is one message in the chat, not two.
    await expect(page.getByText('First draft answer')).toHaveCount(1)
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.getByLabel('Edit message').fill('Final answer after review')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Final answer after review')).toHaveCount(1)
    await expect(page.getByText('First draft answer')).toHaveCount(0)
    // The stored answer (read by lists, the Tickets panel and the dashboard) follows the edit.
    await page.waitForFunction(t => {
      const db = JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}')
      const q = (db.questions ?? []).find((x: { title: string }) => x.title === t)
      return !!q && q.answer === 'Final answer after review' && !JSON.stringify(q).includes('First draft answer')
    }, QUESTION_TITLE, { timeout: 8000 })
    await openBoard(page)
    await card(page, QUESTION_TITLE).click()
    await expect(page.getByText('Final answer after review')).toHaveCount(1)
    await expect(page.getByText('First draft answer')).toHaveCount(0)
    // The team sees the same single, edited answer in the question window from the Tickets questions panel.
    await signIn(page, 'pm')
    await page.goto('/tickets/board')
    await page.getByText('Questions to client').first().click()
    await page.getByText(QUESTION_TITLE).first().click()
    await expect(page.getByText('Final answer after review')).toHaveCount(1)
    await expect(page.getByText('First draft answer')).toHaveCount(0)
  })

  test('CL-24 Escape closes the bug window', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await page.getByRole('button', { name: 'Report a bug' }).first().click()
    await expect(page.getByText('Tell us what went wrong.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Tell us what went wrong.')).toBeHidden()
  })

  test('CL-18 client user attaches a file to a bug report', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await page.getByRole('button', { name: 'Report a bug' }).first().click()
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'screen-capture.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    })
    await expect(page.getByText('screen-capture.png')).toBeVisible()
  })
})

test.describe('Clients board: tasks, drawer and filters', () => {
  test('CL-10 team member adds a task from the To do column quick add', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await page.getByRole('button', { name: 'Add to To do' }).click()
    await page.keyboard.type('Write release notes')
    await page.keyboard.press('Enter')
    await expect(card(page, 'Write release notes')).toBeVisible()
    await waitSaved(page, 'Write release notes')
  })

  test('CL-10 client admin cannot add a task: no quick add on the status columns, only Report a bug', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openBoard(page)
    await expect(page.getByRole('button', { name: 'Report a bug' }).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Project Management tool' })).toBeVisible()
    await expect(card(page, TEAM_TASK)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add to To do' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Add to / })).toHaveCount(0)
  })

  test('CL-11 client user opens a task card and the ticket drawer shows it', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByRole('button', { name: 'Back to board' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: TEAM_TASK })).toBeVisible()
  })

  test('CL-12 team member moves a task to the next status from the drawer', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByRole('button', { name: 'Move to In progress' }).click()
    await expect(page.getByRole('button', { name: 'Move to Review' })).toBeVisible()
    await waitSaved(page, '"status":"prog"')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByRole('button', { name: 'Move to Review' })).toBeVisible()
  })

  test('CL-12 client admin sees a team task as View only and cannot move it (spec marks cadmin as verify)', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByText('View only')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Move to In progress' })).toBeDisabled()
  })

  test('CL-13 team member edits the description of a task', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.getByRole('textbox').last().fill('Cache the task list so it opens without signal.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Cache the task list so it opens without signal.')).toBeVisible()
    await waitSaved(page, 'Cache the task list so it opens without signal.')
  })

  test('CL-13 client admin cannot edit the description of a team task', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByText('View only')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
  })

  test('CL-14 team member adds a subtask to a task', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByText('Add subtasks', { exact: true }).click()
    await page.getByPlaceholder('Add a subtask and press Enter').fill('Measure cache size')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Measure cache size')).toBeVisible()
    await waitSaved(page, 'Measure cache size')
  })

  test('CL-14 client admin cannot add a subtask to a team task', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByText('View only')).toBeVisible()
    await expect(page.getByText('Add subtasks', { exact: true })).toHaveCount(0)
    await expect(page.getByPlaceholder('Add a subtask and press Enter')).toHaveCount(0)
  })

  test('CL-15 team member links a blocking task', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Link task…' }) })
    const value = await select.locator('option', { hasText: 'Dark mode' }).first().getAttribute('value')
    await select.selectOption(value ?? '')
    await expect(page.getByText('Dark mode').first()).toBeVisible()
    await waitSaved(page, 'Dark mode')
  })

  test('CL-16 team member logs time on a task', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.locator('#tk-log').selectOption('2')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('2h', { exact: true }).first()).toBeVisible()
    // The store write lands about 180 ms after the change; wait for the stored entry before reopening.
    await page.waitForFunction(t => {
      const db = JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}')
      const task = (db.tasks ?? []).find((x: { title: string }) => x.title === t)
      return !!task && Object.values(task.time ?? {}).some(h => Number(h) >= 2)
    }, TEAM_TASK, { timeout: 8000 })
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByText('2h', { exact: true }).first()).toBeVisible()
  })

  test('CL-16 client admin cannot log time on a task', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await expect(page.getByText('View only')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log hours' })).toHaveCount(0)
    await expect(page.locator('#tk-log')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
  })

  test('CL-17 client user cannot comment on a team task (the activity is read-only)', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByRole('button', { name: /^Activity/ }).click()
    // The filters still work; there is no comment box or Comment button.
    await page.getByRole('button', { name: 'Comments', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Write a comment, @mention someone…')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0)
  })

  test('CL-17 team member comments on a task and the comment survives reload', async ({ page }) => {
    await signIn(page, 'pm')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByRole('button', { name: /^Activity/ }).click()
    await page.getByPlaceholder('Write a comment, @mention someone…').fill('Any update on the offline cache?')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Any update on the offline cache?')).toBeVisible()
    await waitSaved(page, 'Any update on the offline cache?')
    await openBoard(page)
    await card(page, TEAM_TASK).click()
    await page.getByRole('button', { name: /^Activity/ }).click()
    await expect(page.getByText('Any update on the offline cache?')).toBeVisible()
  })

  test('CL-21 client user filters the board by sprint', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await expect(card(page, 'Login with BankID')).toBeVisible()
    await page.getByRole('button', { name: 'All sprints' }).click()
    await page.getByText('All sprints', { exact: true }).last().click()
    await page.getByText('no sprint', { exact: true }).click()
    await expect(card(page, 'Login with BankID')).toBeHidden()
    await expect(card(page, 'Dark mode')).toBeVisible()
  })

  test('CL-25 client user goes back to the previous view with the Back button', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await page.getByRole('link', { name: 'Timeline' }).click()
    await expect(page).toHaveURL(/\/clients\/timeline/)
    await page.getByRole('button', { name: 'Back to Board' }).click()
    await expect(page).toHaveURL(/\/clients\/board/)
  })
})

test.describe('Clients: epics & sprints, timeline', () => {
  test('CL-22 team member adds an acceptance criterion to an epic doc', async ({ page }) => {
    await signIn(page, 'pm')
    await page.goto('/clients/plan')
    await page.getByRole('button', { name: 'Overview' }).first().click()
    await page.getByPlaceholder('+ Add an acceptance criterion').fill('Users can read tasks offline')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Users can read tasks offline')).toBeVisible()
    await waitSaved(page, 'Users can read tasks offline')
  })

  test('CL-23 client user changes the timeline window and returns to today', async ({ page }) => {
    await signIn(page, 'cuser')
    await page.goto('/clients/timeline')
    const main = page.getByRole('main')
    await expect(main).toContainText('days shown')
    const initial = await main.innerText()
    await page.getByRole('button', { name: 'Next 45 days' }).first().click()
    await expect.poll(async () => main.innerText()).not.toBe(initial)
    await page.getByRole('button', { name: 'Today' }).click()
    await expect.poll(async () => main.innerText()).toBe(initial)
  })
})

test.describe('Clients: a client only raises bugs and answers questions', () => {
  test('CL-26 client admin cannot raise a DevOps request: Tickets is closed to them and the request window is read-only', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/tickets/board')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('button', { name: 'Raise a ticket' })).toHaveCount(0)
    await openBoard(page)
    await card(page, 'Need a staging environment for the Sprint 2 build').click()
    await expect(page).toHaveURL(/request=/)
    await expect(page.getByText('Need a staging environment for the Sprint 2 build').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Overview/ }).first()).toBeVisible()
    await expect(page.getByPlaceholder('Write a comment to DevOps…')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0)
  })

  test('CL-27 client user cannot start a question: only the team raises them', async ({ page }) => {
    await signIn(page, 'cuser')
    await openBoard(page)
    await expect(card(page, QUESTION_TITLE)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Raise a question' })).toHaveCount(0)
    await page.goto('/tickets/board')
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.goto('/devops/board')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('button', { name: 'Raise a question' })).toHaveCount(0)
  })

  test('CL-28 the command layer refuses commands a client forges, and still runs them for the team', async ({ page }) => {
    const task = (id: number, title: string) => ({
      id, title, type: 'Task', status: 'todo', prio: 'Medium', due: '', assignee: '', assignees: [], contribs: [], est: '',
      desc: '', atts: [], subs: [], deps: [], epic: 'mob', sprint: null, start: '2026-10-10', time: {}, acts: [],
    })
    const forged = [
      { type: 'task.create', task: task(9001, 'Forged client task') },
      { type: 'task.update', id: 13, patch: { desc: 'Forged description' }, log: 'edited' },
      { type: 'task.update', id: 13, patch: { subs: [{ t: 'Forged subtask', done: false }] } },
      { type: 'task.update', id: 13, patch: { time: { '2026-10-10': 5 } }, log: 'logged 5h' },
      { type: 'task.update', id: 13, patch: { status: 'prog' }, log: 'moved it to In progress' },
      { type: 'task.comment', id: 13, text: 'Forged comment' },
      { type: 'request.create', request: { id: 9001, key: 'OPS-101', pname: 'Daco platform', rkey: 'REQ-9001', type: 'Deployment', prio: 'Medium', to: '', text: 'Forged request', by: 'Ingrid Solberg', when: 'just now' } },
      { type: 'question.create', question: { id: 9001, by: 'Ingrid Solberg', title: 'Forged question', text: '', when: 'just now', task: 13, answer: '' } },
      // A batch that hides a refused command among allowed ones is refused as a whole.
      { type: 'batch', cmds: [{ type: 'batch', cmds: [] }, { type: 'task.comment', id: 13, text: 'Forged in a batch' }] },
    ]
    await signIn(page, 'cadmin')
    await openBoard(page)
    for (const cmd of forged) {
      const res = await sendCommand(page, cmd)
      expect(res.ok, `${JSON.stringify(cmd).slice(0, 80)} should be refused`).toBe(false)
      if (!res.ok) expect(res.error).toContain('Clients cannot')
    }
    // Nothing forged reached the store (a harmless allowed write makes sure it exists).
    expect(await sendCommand(page, { type: 'batch', cmds: [] })).toEqual({ ok: true })
    const stored = await page.evaluate(() => localStorage.getItem('vt.clients.db') ?? '')
    expect(stored).toContain('"devopsLinks"')
    for (const text of ['Forged client task', 'Forged description', 'Forged subtask', 'Forged comment', 'Forged request', 'Forged question', 'Forged in a batch'])
      expect(stored).not.toContain(text)
    const t13 = await page.evaluate(() => JSON.parse(localStorage.getItem('vt.clients.db') ?? '{}').tasks.find((t: { id: number }) => t.id === 13))
    expect(t13.status).toBe('todo')
    expect(t13.time ?? {}).toEqual({})

    // The same write from a team member goes through.
    await signIn(page, 'pm')
    await openBoard(page)
    expect(await sendCommand(page, { type: 'task.comment', id: 13, text: 'Team comment via the command layer' })).toEqual({ ok: true })
    await waitSaved(page, 'Team comment via the command layer')
  })
})
