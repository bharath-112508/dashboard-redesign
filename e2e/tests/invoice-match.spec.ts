import { test, expect, type Page } from '@playwright/test'
import { signIn } from './helpers/session'
import { menu, openTickets } from './helpers/tickets'

/**
 * InvoiceMatch (v5): Daco's delivered project on the Clients portal, its
 * embedded live app (inbox, match review, reports) and "Send feedback", whose
 * reports become client bug tickets. Flow IDs IM-01 to IM-12.
 */

const BASE = '/clients/live/invoicematch'

type Stored = {
  tasks: { id: number; title: string; epic: string; prio: string; desc: string; clientBug?: unknown; acts: { who: string; what?: string }[]; atts: { name: string; url?: string }[] }[]
  invoiceMatch: { invoices: { no: string; decision?: { st: string; note: string; by: string } }[] }
  workspace: { epics: { id: string }[] }
}

const stored = (page: Page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('vt.clients.db') ?? 'null')
    } catch {
      return null
    }
  }) as Promise<Stored | null>

/** Waits until the store satisfies `ok` (writes land after a short delay). */
async function waitStored(page: Page, ok: (db: Stored) => boolean, what: string) {
  await expect.poll(async () => {
    const db = await stored(page)
    return !!db && ok(db)
  }, { timeout: 8000, message: what }).toBe(true)
}

const app = (page: Page) => page.getByTestId('invoice-match')
const fbDialog = (page: Page) => page.getByRole('dialog', { name: 'Send feedback' })

async function openLive(page: Page, path = '/inbox') {
  await page.goto(BASE + path)
  await expect(app(page).getByText('Daco · Accounts payable')).toBeVisible()
}

async function openImProject(page: Page) {
  await page.goto('/clients')
  await page.getByRole('article', { name: 'InvoiceMatch' }).getByRole('button', { name: 'Open project ›' }).click()
  await expect(page).toHaveURL(/\/clients\/board/)
  await expect(page.getByRole('heading', { name: 'InvoiceMatch' })).toBeVisible()
}

test.describe('InvoiceMatch project on the Clients portal', () => {
  test('IM-01 Daco sees the live InvoiceMatch card and opens its board', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/clients')
    await expect(page.getByText('Daco · 2 projects')).toBeVisible()
    const im = page.getByRole('article', { name: 'InvoiceMatch' })
    await expect(im.getByText('Completed 28 Sep · live at invoicematch.daco.no')).toBeVisible()
    await expect(im.getByText('99.98%')).toBeVisible()
    await expect(im.getByText('1.4.2')).toBeVisible()
    await expect(im.getByText('Live · last deployed 9 Oct')).toBeVisible()

    await openImProject(page)
    await expect(page.getByText('Completed', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Live app ↗' })).toBeVisible()
    await expect(page.getByTitle('Updated by the DevOps team')).toContainText('Live')
    await expect(page.getByText('All caught up')).toBeVisible()
    await expect(page.getByText('Go-live and handover')).toBeVisible()
    await expect(page.getByText('Login with BankID')).toHaveCount(0)

    // The epic picker lists the project's two epics only.
    await page.getByRole('button', { name: /^Epic/ }).click()
    await expect(page.getByText('Matching engine', { exact: true })).toBeVisible()
    await expect(page.getByText('Review & reports', { exact: true })).toBeVisible()
    await expect(page.getByText('Mobile app', { exact: true })).toHaveCount(0)
  })

  test('IM-01 other Daco projects do not list the InvoiceMatch epics', async ({ page }) => {
    await signIn(page, 'cadmin')
    await page.goto('/clients')
    await page.getByRole('article', { name: 'Daco platform' }).getByRole('button', { name: 'Open project ›' }).click()
    await expect(page.getByRole('heading', { name: 'Project Management tool' })).toBeVisible()
    await page.getByRole('button', { name: /^Epic/ }).click()
    await expect(page.getByText('Web app', { exact: true })).toBeVisible()
    await expect(page.getByText('Matching engine', { exact: true })).toHaveCount(0)
  })

  test('IM-02 "Live app" opens the embedded app and "Back to InvoiceMatch project" returns', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openImProject(page)
    await page.getByRole('button', { name: 'Live app ↗' }).click()
    await expect(page).toHaveURL(/\/clients\/live\/invoicematch\/inbox$/)
    await expect(page.getByText('Daco · Completed project · Live')).toBeVisible()
    await expect(page.getByText('Live · 99.98% uptime')).toBeVisible()
    await expect(page.getByTestId('im-url')).toHaveText('invoicematch.daco.no/inbox')
    await page.getByRole('button', { name: 'Back to InvoiceMatch project' }).click()
    await expect(page).toHaveURL(/\/clients\/board/)
    await expect(page.getByRole('heading', { name: 'InvoiceMatch' })).toBeVisible()
  })

  test('IM-13 a client of another company cannot open the live app', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('name@company.com').fill('kari@nordlys.no')
    await page.getByPlaceholder('••••••••').fill('demo')
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'))
    await page.goto(BASE + '/inbox')
    await expect(page).toHaveURL(/\/clients$/)
    await expect(page.getByRole('article', { name: 'InvoiceMatch' })).toHaveCount(0)
  })
})

test.describe('InvoiceMatch live app', () => {
  test('IM-03 inbox filters, search and "Review next exception"', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page)
    const rows = app(page).getByRole('table', { name: 'Invoices' }).getByRole('row')
    await expect(rows).toHaveCount(11)
    await app(page).getByRole('button', { name: /^Needs attention/ }).click()
    await expect(rows).toHaveCount(7)
    await app(page).getByRole('button', { name: /^On hold/ }).click()
    await expect(app(page).getByText('No invoices match these filters.')).toBeVisible()
    await app(page).getByRole('button', { name: /^All/ }).click()
    await app(page).getByLabel('Search invoices').fill('ahlsell')
    await expect(rows).toHaveCount(3)
    await app(page).getByLabel('Search invoices').fill('')
    await app(page).getByRole('button', { name: 'Review next exception' }).click()
    await expect(page).toHaveURL(/\/invoices\/INV-20417$/)
    await expect(app(page).getByRole('heading', { name: 'Invoice INV-20417' })).toBeVisible()
    await expect(app(page).getByRole('cell', { name: '+8% over PO' })).toBeVisible()
    await expect(app(page).getByText('Exception: needs a decision')).toBeVisible()
  })

  test('IM-04 approve with a note is saved, and Undo decision brings the exception back', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page, '/invoices/INV-20417')
    await app(page).getByLabel('Note').fill('Agreed new price')
    await app(page).getByRole('button', { name: 'Approve for payment' }).click()
    await expect(page.getByText('Invoice INV-20417 approved for payment')).toBeVisible()
    await expect(page.getByTestId('im-status')).toHaveText('Approved')
    await expect(app(page).getByText('By Ingrid Solberg · “Agreed new price”')).toBeVisible()
    await waitStored(page, db => db.invoiceMatch.invoices.find(i => i.no === 'INV-20417')?.decision?.st === 'approved', 'approval saved')
    await page.reload()
    await expect(page.getByTestId('im-status')).toHaveText('Approved')
    // Inbox: one exception fewer, approval raises the auto-match rate.
    await app(page).getByRole('button', { name: /^Inbox/ }).click()
    await expect(app(page).getByRole('button', { name: /^Needs attention/ })).toContainText('5')
    await expect(app(page).getByText('81%')).toBeVisible()

    await app(page).getByText('INV-20417').click()
    await app(page).getByRole('button', { name: 'Undo decision' }).click()
    await expect(page.getByTestId('im-status')).toHaveText('Price mismatch')
    await waitStored(page, db => !db.invoiceMatch.invoices.find(i => i.no === 'INV-20417')?.decision, 'undo saved')
  })

  test('IM-05 hold and reject, Previous and Next, automatic matches need no action', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page, '/invoices/INV-20415')
    await app(page).getByRole('button', { name: 'Put on hold' }).click()
    await expect(page.getByTestId('im-status')).toHaveText('On hold')
    await app(page).getByRole('button', { name: 'Next ›' }).click()
    await expect(app(page).getByRole('heading', { name: 'Invoice INV-20412' })).toBeVisible()
    await expect(app(page).getByText('There is no purchase order for this invoice.')).toBeVisible()
    await app(page).getByRole('button', { name: 'Reject' }).click()
    await expect(page.getByText('Invoice INV-20412 rejected and sent back to supplier')).toBeVisible()
    await expect(page.getByTestId('im-status')).toHaveText('Rejected')
    await app(page).getByRole('button', { name: '‹ Previous' }).click()
    await app(page).getByRole('button', { name: '‹ Previous' }).click()
    await app(page).getByRole('button', { name: '‹ Previous' }).click()
    await expect(app(page).getByRole('heading', { name: 'Invoice INV-20418' })).toBeVisible()
    await expect(app(page).getByText('Approved automatically')).toBeVisible()
    await expect(app(page).getByRole('button', { name: 'Undo decision' })).toHaveCount(0)
    await app(page).getByRole('button', { name: /^Inbox/ }).click()
    await app(page).getByRole('button', { name: /^On hold/ }).click()
    await expect(app(page).getByRole('table', { name: 'Invoices' }).getByRole('row')).toHaveCount(2)
  })

  test('IM-06 reports show the match rate and export a CSV', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page, '/reports')
    await expect(page.getByTestId('im-url')).toHaveText('invoicematch.daco.no/reports')
    await expect(app(page).getByRole('region', { name: 'Auto-match rate by month' })).toContainText('86%')
    await expect(app(page).getByRole('region', { name: 'Exceptions by supplier' })).toContainText('Ahlsell Norge')
    const [dl] = await Promise.all([page.waitForEvent('download'), app(page).getByRole('button', { name: 'Export CSV' }).click()])
    expect(dl.suggestedFilename()).toBe('invoicematch-october.csv')
    await expect(page.getByText('Report exported')).toBeVisible()
  })
})

test.describe('InvoiceMatch feedback', () => {
  test('IM-07 a screenshot report becomes a client bug on the board with the capture stored in IndexedDB', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page, '/reports')
    await app(page).getByRole('button', { name: 'Feedback' }).click()
    await expect(fbDialog(page)).toBeVisible()
    await fbDialog(page).getByRole('button', { name: 'Send bug report' }).click()
    await expect(fbDialog(page).getByText('Add a title')).toBeVisible()

    await fbDialog(page).getByRole('button', { name: 'Screenshot' }).click()
    await expect(fbDialog(page).getByRole('img', { name: 'Screenshot' })).toBeVisible()
    await expect(fbDialog(page).getByText('screenshot-reports.png')).toBeVisible()
    await fbDialog(page).getByPlaceholder('What went wrong?').fill('Totals look off')
    await fbDialog(page).getByPlaceholder(/What did you do/).fill('October bar is lower than expected')
    await fbDialog(page).getByRole('button', { name: 'High', exact: true }).click()
    await expect(fbDialog(page).getByText(/Sent with: Reports · 10 Oct/)).toBeVisible()
    await fbDialog(page).getByRole('button', { name: 'Send bug report' }).click()
    await expect(fbDialog(page).getByText("Thanks, it's with the team")).toBeVisible()
    await expect(page.getByTestId('im-done-key')).toHaveText(/^PMT-\d+$/)

    await waitStored(page, db => db.tasks.some(t => t.title === 'Totals look off' && !!t.atts[0]?.url?.startsWith('idb:')), 'bug saved with an IndexedDB attachment')
    const db = (await stored(page))!
    const bug = db.tasks.find(t => t.title === 'Totals look off')!
    expect(bug.epic).toBe('im2')
    expect(bug.prio).toBe('High')
    expect(bug.clientBug).toBeTruthy()
    expect(bug.desc).toContain('October bar is lower than expected')
    expect(bug.desc).toContain('Sent from: Reports')
    expect(bug.acts[0]).toMatchObject({ who: 'Ingrid Solberg', what: 'reported this bug from the live app' })
    await expect(page.getByTestId('im-done-key')).toHaveText('PMT-' + bug.id)

    await fbDialog(page).getByRole('button', { name: 'Done' }).click()
    await expect(fbDialog(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to InvoiceMatch project' }).click()
    await expect(page.getByText('Totals look off')).toBeVisible()
    await page.reload()
    // The picked project is page state, so after a reload it is opened from the portal again.
    await openImProject(page)
    await page.getByText('Totals look off').click()
    // The bug window names the reporter and shows the capture after a reload (read back from IndexedDB).
    await expect(page.getByText('Ingrid Solberg').first()).toBeVisible()
    await expect(page.getByRole('img', { name: 'screenshot-reports.png' })).toHaveAttribute('style', /data:image\/png/)
  })

  test('IM-08 Snippet: drag over part of the app to capture it; Escape steps back', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page)
    // Ctrl+Shift+5 starts a snippet straight away.
    await page.keyboard.press('Control+Shift+5')
    await expect(page.getByText('Drag over the part that looks wrong')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fbDialog(page)).toBeVisible()
    await fbDialog(page).getByRole('button', { name: 'Snippet' }).click()
    const box = (await app(page).boundingBox())!
    await page.mouse.move(box.x + 60, box.y + 120)
    await page.mouse.down()
    await page.mouse.move(box.x + 360, box.y + 320, { steps: 6 })
    await expect(page.getByText('300 × 200')).toBeVisible()
    await page.mouse.up()
    const img = fbDialog(page).getByRole('img', { name: 'Screenshot' })
    await expect(img).toBeVisible()
    await expect(fbDialog(page).getByText('snippet-inbox.png')).toBeVisible()
    // The image has the snippet's proportions (3:2).
    const ratio = await img.evaluate((el: HTMLImageElement) => el.naturalWidth / el.naturalHeight)
    expect(ratio).toBeCloseTo(1.5, 1)
    await fbDialog(page).getByRole('button', { name: 'Remove' }).click()
    await expect(fbDialog(page).getByRole('button', { name: 'Snippet' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fbDialog(page)).toHaveCount(0)
  })

  test('IM-09 Record: a refused screen share explains what to do instead', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        value: async () => {
          throw new DOMException('Permission denied', 'NotAllowedError')
        },
      })
    })
    await signIn(page, 'cadmin')
    await openLive(page)
    await app(page).getByRole('button', { name: 'Feedback' }).click()
    await fbDialog(page).getByRole('button', { name: 'Record' }).click()
    await expect(fbDialog(page).getByText('Screen recording was blocked or cancelled. You can upload a video instead.')).toBeVisible()
  })

  test('IM-10 Record: a screen recording is attached to the bug as a video', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        value: async () => {
          const c = document.createElement('canvas')
          c.width = 320
          c.height = 200
          const g = c.getContext('2d')!
          let n = 0
          setInterval(() => {
            g.fillStyle = n++ % 2 ? '#1D4ED8' : '#F59E0B'
            g.fillRect(0, 0, 320, 200)
          }, 40)
          return c.captureStream(15)
        },
      })
    })
    await signIn(page, 'cadmin')
    await openLive(page)
    await app(page).getByRole('button', { name: 'Feedback' }).click()
    await fbDialog(page).getByRole('button', { name: 'Record' }).click()
    await expect(page.getByText(/^Recording \d:\d\d$/)).toBeVisible()
    await expect(fbDialog(page)).toHaveCount(0)
    await expect(page.getByText('Recording 0:01')).toBeVisible()
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(fbDialog(page).locator('video')).toBeVisible()
    await expect(fbDialog(page).getByText(/recording-inbox-\d+s\.webm/)).toBeVisible()
    await fbDialog(page).getByPlaceholder('What went wrong?').fill('Filter chips flicker')
    await fbDialog(page).getByRole('button', { name: 'Send bug report' }).click()
    await expect(fbDialog(page).getByText("Thanks, it's with the team")).toBeVisible()
    await waitStored(
      page,
      db => db.tasks.some(t => t.title === 'Filter chips flicker' && /\.webm$/.test(t.atts[0]?.name ?? '') && !!t.atts[0]?.url?.startsWith('idb:')),
      'video attachment saved',
    )
  })

  test('IM-11 a bug sent from the live app shows in Tickets for the team', async ({ page }) => {
    await signIn(page, 'cadmin')
    await openLive(page)
    await app(page).getByRole('button', { name: 'Feedback' }).click()
    await fbDialog(page).getByPlaceholder('What went wrong?').fill('PO column is cut off')
    await fbDialog(page).getByRole('button', { name: 'Send bug report' }).click()
    await expect(fbDialog(page).getByText("Thanks, it's with the team")).toBeVisible()
    await waitStored(page, db => db.tasks.some(t => t.title === 'PO column is cut off'), 'bug saved')

    await page.goto('/login')
    await page.getByPlaceholder('name@company.com').fill('rahul@viljetech.com')
    await page.getByPlaceholder('••••••••').fill('demo')
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'))
    await openTickets(page, 'board')
    await page.getByRole('button', { name: /^Epic/ }).click()
    await menu(page).getByText('Review & reports', { exact: true }).click()
    await menu(page).getByText('Mobile app', { exact: true }).click()
    await page.locator('div.fixed.inset-0').first().click()
    await expect(page.getByText('PO column is cut off', { exact: true })).toBeVisible()
  })

  test('IM-12 a store saved before v5 gains the InvoiceMatch project on load', async ({ page }) => {
    await signIn(page, 'cadmin')
    // The seed is only written on the first change, so make one.
    await openLive(page, '/invoices/INV-20409')
    await app(page).getByRole('button', { name: 'Approve for payment' }).click()
    await waitStored(page, db => db.workspace.epics.some(e => e.id === 'im1') && !!db.invoiceMatch.invoices[5].decision, 'seeded')
    await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('vt.clients.db')!)
      d.workspace.epics = d.workspace.epics.filter((e: { id: string }) => !['im1', 'im2'].includes(e.id))
      d.workspace.sprints = d.workspace.sprints.filter((s: { epic: string }) => !['im1', 'im2'].includes(s.epic))
      d.tasks = d.tasks.filter((t: { epic: string }) => !['im1', 'im2'].includes(t.epic))
      delete d.invoiceMatch
      localStorage.setItem('vt.clients.db', JSON.stringify(d))
    })
    await openImProject(page)
    await expect(page.getByText('Go-live and handover')).toBeVisible()
    await page.getByRole('button', { name: 'Live app ↗' }).click()
    await expect(app(page).getByRole('table', { name: 'Invoices' }).getByRole('row')).toHaveCount(11)
  })
})
