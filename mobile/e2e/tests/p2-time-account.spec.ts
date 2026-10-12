import { expect, test, type Page } from '@playwright/test';

import {
  ACCOUNTS,
  byTestId,
  expectScreen,
  goTab,
  screen,
  selectedTab,
  signInAs,
  signInWithEmail,
} from '../helpers/session';

/**
 * P2: Time, Leave, Team and Account (SPEC S-TIME, S-LOG, S-HISTORY, S-LEAVE,
 * S-LEAVESHEET, S-TEAM, S-ME, S-MORE). Every test title starts with its flow id.
 * Seed facts: TODAY = Sat 10 Oct 2026; this week 29h (26h 30m billable, 2h 30m non, 11h idle).
 */

const sheet = (page: Page, id: string) => page.getByTestId(`sheet-${id}`);
const toast = (page: Page) => page.getByTestId('toast');

async function openTime(page: Page) {
  await goTab(page, 'time');
  await expect(byTestId(page, 'time-total')).toBeVisible();
}

async function openLog(page: Page) {
  await byTestId(page, 'action-log').click();
  await expect(sheet(page, 'log-time')).toBeVisible();
}

/** Select an option of a labelled <select> in the log sheet. */
async function pick(page: Page, label: string, value: string | { label: string }) {
  await sheet(page, 'log-time').getByLabel(label, { exact: true }).selectOption(value);
}

/** Switch to another sample account from More (M-03, M-02) without clearing the store. */
async function switchTo(page: Page, role: 'dev' | 'free' | 'pm' | 'client') {
  await goTab(page, 'more');
  await byTestId(page, 'more-switch-account').click();
  await page.getByTestId(`account-${role}`).click();
  await expectScreen(page, 'home');
}

async function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vt.mobile.v4') ?? '{}'));
}

/** Tickets from the persisted store (the store is persisted as {state} or as the state). */
async function ticketHours(page: Page, id: number): Promise<number> {
  const raw = await stored(page);
  const s = raw.state ?? raw;
  return s.tickets.find((t: { id: number }) => t.id === id).hrs;
}

// ── Account ────────────────────────────────────────────────────────────────

test.describe('account', () => {
  test('M-01 sign in with email and password opens Home for that account', async ({ page }) => {
    await signInWithEmail(page, ACCOUNTS.pm.email);
    await expectScreen(page, 'home');
    await byTestId(page, 'header-avatar').click();
    await expectScreen(page, 'me');
    await expect(byTestId(page, 'me-card')).toContainText('Vivek');
    await expect(byTestId(page, 'me-card')).toContainText(ACCOUNTS.pm.email);
  });

  test('M-01 wrong password keeps the sign in screen with the error', async ({ page }) => {
    await signInWithEmail(page, ACCOUNTS.dev.email, 'nope');
    await expect(page.getByTestId('form-error')).toHaveText('That password is not right.');
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });

  test('M-02 sample account opens Home; More shows that person', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'more');
    await expect(byTestId(page, 'more-profile')).toContainText('Ganesh');
    await expect(byTestId(page, 'more-profile')).toContainText('DevOps engineer · View profile');
  });

  test('M-03 switch account from Profile returns to sign in and keeps the email', async ({ page }) => {
    await signInWithEmail(page, ACCOUNTS.dev.email);
    await expectScreen(page, 'home');
    await byTestId(page, 'header-avatar').click();
    await byTestId(page, 'me-switch-account').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveValue(ACCOUNTS.dev.email);
  });

  test('M-03 switch account from More', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'more');
    await byTestId(page, 'more-switch-account').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });

  test('M-04 sign out from Profile clears the email', async ({ page }) => {
    await signInWithEmail(page, ACCOUNTS.admin.email);
    await expectScreen(page, 'home');
    await byTestId(page, 'header-avatar').click();
    await byTestId(page, 'me-sign-out').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveValue('');
  });

  test('M-04 sign out from More', async ({ page }) => {
    await signInAs(page, 'free');
    await goTab(page, 'more');
    await byTestId(page, 'more-sign-out').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });

  test('M-08 profile from the avatar and from the More card; rows per role', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'header-avatar').click();
    await expectScreen(page, 'me');
    const me = screen(page, 'me');
    await expect(me).toContainText('Chary');
    await expect(me).toContainText('Developer · Frontend');
    await expect(me).toContainText('chary@viljetech.com');
    await expect(byTestId(page, 'me-leave')).toContainText('Requests and status');
    await expect(byTestId(page, 'me-inbox')).toContainText('6 unread');
    await byTestId(page, 'me-time').click();
    await expectScreen(page, 'time');
    expect(await selectedTab(page)).toBe('Time');

    await goTab(page, 'more');
    await byTestId(page, 'more-profile').click();
    await expectScreen(page, 'me');
    expect(await selectedTab(page)).toBe('More');
    await byTestId(page, 'me-leave').click();
    await expectScreen(page, 'leave');
  });

  test('M-08 approver sees the pending count; client has no leave or timesheet row', async ({ page }) => {
    await signInAs(page, 'pm');
    await byTestId(page, 'header-avatar').click();
    await expect(byTestId(page, 'me-leave')).toContainText('3 waiting for approval');
    await switchTo(page, 'client');
    await byTestId(page, 'header-avatar').click();
    await expectScreen(page, 'me');
    await expect(byTestId(page, 'me-leave')).toHaveCount(0);
    await expect(byTestId(page, 'me-time')).toHaveCount(0);
    await expect(byTestId(page, 'me-inbox')).toContainText('4 unread');
    await expect(byTestId(page, 'me-card').getByRole('img', { name: 'Ingrid Solberg' })).toHaveText('IS');
  });

  test('M-08 freelancer profile has no leave row', async ({ page }) => {
    await signInAs(page, 'free');
    await byTestId(page, 'header-avatar').click();
    await expectScreen(page, 'me');
    await expect(byTestId(page, 'me-leave')).toHaveCount(0);
    await expect(byTestId(page, 'me-time')).toBeVisible();
  });

  test('M-09 push notifications toggle flips and persists', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/me');
    const sw = byTestId(page, 'me-push').getByRole('switch', { name: 'Push notifications' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'me-push')).toContainText('On');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(byTestId(page, 'me-push')).toContainText('Off');
    await page.reload();
    await expectScreen(page, 'me');
    await expect(byTestId(page, 'me-push')).toContainText('Off');
  });

  test('More tiles and subtitles per role (dev, pm)', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'more');
    await expect(byTestId(page, 'more-tile-leave')).toContainText('1 pending');
    await expect(byTestId(page, 'more-tile-history')).toContainText('Filter & download');
    await byTestId(page, 'more-tile-history').click();
    await expectScreen(page, 'history');
    expect(await selectedTab(page)).toBe('More');
    await switchTo(page, 'pm');
    await goTab(page, 'more');
    await expect(byTestId(page, 'more-tile-leave')).toContainText('3 to approve');
    await expect(byTestId(page, 'more-tile-team')).toContainText('This week');
  });
});

// ── Time ───────────────────────────────────────────────────────────────────

test.describe('timesheet', () => {
  test('S-TIME this week summary matches the seed (dev and free)', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await expect(byTestId(page, 'time-total')).toHaveText('29h');
    const sum = byTestId(page, 'time-summary');
    await expect(sum).toContainText('of 40h');
    await expect(sum).toContainText('26h 30m');
    await expect(sum).toContainText('2h 30m');
    await expect(sum).toContainText('Idle');
    await expect(sum).toContainText('11h');
    await expect(byTestId(page, 'day-toggle-2026-10-05')).toHaveAttribute('aria-label', 'Mon 5 Oct, 7h 30m');
    await expect(byTestId(page, 'day-toggle-2026-10-10')).toHaveAttribute('aria-label', 'Sat 10 Oct, nothing logged');

    await switchTo(page, 'free');
    await openTime(page);
    await expect(byTestId(page, 'time-summary')).toContainText('logged');
    await expect(byTestId(page, 'time-summary')).not.toContainText('Idle');
  });

  test('M-19 expanding a day shows its entries; one day open at a time', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    const tue = byTestId(page, 'day-toggle-2026-10-06');
    const mon = byTestId(page, 'day-toggle-2026-10-05');
    await tue.click();
    await expect(tue).toHaveAttribute('aria-expanded', 'true');
    const tueCard = byTestId(page, 'day-2026-10-06');
    await expect(tueCard.getByTestId('day-entry')).toHaveCount(3);
    await expect(tueCard).toContainText('PMT-11');
    await expect(tueCard).toContainText('Push notifications');
    await expect(tueCard).toContainText('Android testing');
    await expect(tueCard).toContainText('Sprint planning');
    await expect(tueCard).toContainText('Internal');
    await expect(tueCard).toContainText('Non-bill');
    await expect(tueCard.getByTestId('log-day')).toHaveText('+ Log time for Tue');
    await mon.click();
    await expect(mon).toHaveAttribute('aria-expanded', 'true');
    await expect(tue).toHaveAttribute('aria-expanded', 'false');
    await mon.click();
    await expect(mon).toHaveAttribute('aria-expanded', 'false');
    // Today with nothing logged; Sunday (future) has no log button.
    await byTestId(page, 'day-toggle-2026-10-10').click();
    await expect(byTestId(page, 'day-2026-10-10')).toContainText('Nothing logged.');
    await expect(byTestId(page, 'day-2026-10-10').getByTestId('log-day')).toHaveText('+ Log time for Sat');
    await byTestId(page, 'day-toggle-2026-10-11').click();
    await expect(byTestId(page, 'day-2026-10-11').getByTestId('log-day')).toHaveCount(0);
  });

  test('M-18 browse weeks: range, label, generated past data, next disabled on this week', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    const next = byTestId(page, 'week-next');
    await expect(byTestId(page, 'week-range')).toContainText('5 Oct – 11 Oct');
    await expect(byTestId(page, 'week-rel')).toHaveText('This week');
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await byTestId(page, 'day-toggle-2026-10-06').click();
    await byTestId(page, 'week-prev').click();
    await expect(byTestId(page, 'week-range')).toContainText('28 Sep – 4 Oct');
    await expect(byTestId(page, 'week-rel')).toHaveText('Last week');
    await expect(byTestId(page, 'time-total')).toHaveText('37h 30m');
    await expect(byTestId(page, 'time-summary')).toContainText('2h 30m');
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    await expect(byTestId(page, 'day-toggle-2026-09-28')).toHaveAttribute('aria-expanded', 'false');
    await byTestId(page, 'day-toggle-2026-09-28').click();
    await expect(byTestId(page, 'day-2026-09-28')).toContainText('Standup & reviews');
    await expect(byTestId(page, 'day-2026-09-28')).toContainText('PMT-08');
    await byTestId(page, 'week-prev').click();
    await expect(byTestId(page, 'week-rel')).toHaveText('2 weeks ago');
    await next.click();
    await next.click();
    await expect(byTestId(page, 'week-rel')).toHaveText('This week');
    await next.click({ force: true });
    await expect(byTestId(page, 'week-rel')).toHaveText('This week');
    // the open day reset when the week changed
    await expect(byTestId(page, 'day-toggle-2026-10-06')).toHaveAttribute('aria-expanded', 'false');
  });

  test('M-15 log time from the header: describe the work, hours and minutes', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await openLog(page);
    const s = sheet(page, 'log-time');
    await expect(s).toContainText('Today, Sat 10 Oct · logged as Chary');
    await expect(s.getByLabel('Ticket', { exact: true })).toHaveCount(0);
    await pick(page, 'Project', 'Daco platform');
    const ticket = s.getByLabel('Ticket', { exact: true });
    await expect(ticket.locator('option').first()).toHaveText('No ticket, describe the work');
    await expect(ticket.locator('option', { hasText: 'PMT-11 · Push notifications' })).toHaveCount(1);
    await s.getByLabel('What did you work on?').fill('Design sync');
    await pick(page, 'Minutes', '30');
    await s.getByRole('tab', { name: 'Non-billable' }).click();
    await s.getByLabel('Note').fill('With the client');
    await page.getByTestId('log-save').click();
    await expect(sheet(page, 'log-time')).toHaveCount(0);
    await expect(toast(page)).toHaveText('Logged 1h 30m');
    await expect(byTestId(page, 'time-total')).toHaveText('30h 30m');
    await expect(byTestId(page, 'day-toggle-2026-10-10')).toHaveAttribute('aria-label', 'Sat 10 Oct, 1h 30m');
    await byTestId(page, 'day-toggle-2026-10-10').click();
    const sat = byTestId(page, 'day-2026-10-10');
    await expect(sat).toContainText('Design sync');
    await expect(sat).toContainText('With the client');
    await expect(sat).toContainText('Non-bill');
  });

  test('M-15 log time on a ticket adds hours to the ticket; Internal defaults to non-billable', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    const before = await ticketHours(page, 2);
    await openLog(page);
    const s = sheet(page, 'log-time');
    await pick(page, 'Project', 'Internal');
    await expect(s.getByRole('tab', { name: 'Non-billable' })).toHaveAttribute('aria-selected', 'true');
    await expect(s.getByLabel('Ticket', { exact: true }).locator('option')).toHaveText(['No open tickets, describe the work']);
    await pick(page, 'Project', 'Daco platform');
    await expect(s.getByRole('tab', { name: 'Billable', exact: true })).toHaveAttribute('aria-selected', 'true');
    await pick(page, 'Ticket', { label: 'PMT-20 · Ticket import' });
    await expect(s.getByLabel('What did you work on?')).toHaveCount(0);
    await pick(page, 'Hours', '2');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 2h on PMT-20');
    await expect(byTestId(page, 'time-total')).toHaveText('31h');
    await expect.poll(() => ticketHours(page, 2)).toBe(before + 2);
  });

  test('M-14 the sheet opened with a ticket presets project and ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    const before = await ticketHours(page, 1);
    await page.goto('/sheet/log-time?ticketId=1');
    const s = sheet(page, 'log-time');
    await expect(s).toBeVisible();
    await expect(s.getByLabel('Project', { exact: true })).toHaveValue('Daco platform');
    await expect(s.getByLabel('Ticket', { exact: true })).toHaveValue('1');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 1h on PMT-11');
    await expect.poll(() => ticketHours(page, 1)).toBe(before + 1);
  });

  test('M-16 log time for a past day from the expanded row', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await byTestId(page, 'day-toggle-2026-10-06').click();
    await byTestId(page, 'day-2026-10-06').getByTestId('log-day').click();
    const s = sheet(page, 'log-time');
    await expect(s).toContainText('Tue 6 Oct · logged as Chary');
    await expect(s).not.toContainText('Today');
    await pick(page, 'Project', 'Internal');
    await s.getByLabel('What did you work on?').fill('Hiring interviews');
    await pick(page, 'Hours', '2');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 2h');
    await expect(byTestId(page, 'day-toggle-2026-10-06')).toHaveAttribute('aria-label', 'Tue 6 Oct, 8h');
    await expect(byTestId(page, 'day-2026-10-06').getByTestId('day-entry')).toHaveCount(4);
  });

  test('M-17 validation errors in order; typing clears; the sheet stays open', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await openLog(page);
    const s = sheet(page, 'log-time');
    const err = s.getByTestId('form-error');
    await pick(page, 'Hours', '0');
    await page.getByTestId('log-save').click();
    await expect(err).toHaveText('Pick the hours or minutes you worked.');
    await pick(page, 'Minutes', '15');
    await expect(err).toHaveCount(0);
    await page.getByTestId('log-save').click();
    await expect(err).toHaveText('Pick the project you worked on.');
    await pick(page, 'Project', 'Daco platform');
    await expect(err).toHaveCount(0);
    await page.getByTestId('log-save').click();
    await expect(err).toHaveText('Pick a ticket or describe the work.');
    await s.getByLabel('What did you work on?').fill('x');
    await expect(err).toHaveCount(0);
    await expect(s).toBeVisible();
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 15m');
  });

  test('M-46 closing the log sheet discards the form', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await openLog(page);
    await pick(page, 'Project', 'Daco platform');
    await page.getByTestId('sheet-close').click();
    await expect(sheet(page, 'log-time')).toHaveCount(0);
    await openLog(page);
    await expect(sheet(page, 'log-time').getByLabel('Project', { exact: true })).toHaveValue('');
  });

  test('M-34 log time to a support plan: project and text preset', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto(`/sheet/log-time?project=${encodeURIComponent('Daco website')}&text=${encodeURIComponent('Daco website · support')}`);
    const s = sheet(page, 'log-time');
    await expect(s.getByLabel('Project', { exact: true })).toHaveValue('Daco website');
    await expect(s.getByLabel('What did you work on?')).toHaveValue('Daco website · support');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 1h');
    await page.goto('/history');
    await expect(screen(page, 'history').getByTestId('history-row').first()).toContainText('Daco website · support');
  });

  test('M-34 text-only support param derives the project', async ({ page }) => {
    await signInAs(page, 'devops');
    await page.goto(`/sheet/log-time?text=${encodeURIComponent('Daco website · support')}`);
    await expect(sheet(page, 'log-time').getByLabel('Project', { exact: true })).toHaveValue('Daco website');
  });
});

// ── History ────────────────────────────────────────────────────────────────

test.describe('time history', () => {
  test('M-42 filter by billing and project, empty state', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-history').click();
    await expectScreen(page, 'history');
    const total = byTestId(page, 'history-total');
    await expect(total).toHaveText('141h 30m · 40 entries');
    const first = screen(page, 'history').getByTestId('history-day').first();
    await expect(first).toContainText('Fri 9 Oct');
    await expect(first).toContainText('PMT-11 · Push notifications');
    await page.getByRole('radio', { name: 'Non-billable' }).click();
    await expect(total).toHaveText('25h · 17 entries');
    await page.getByRole('radio', { name: 'Billable', exact: true }).click();
    await expect(total).toHaveText('116h 30m · 23 entries');
    await page.getByRole('radio', { name: 'Daco intranet' }).click();
    await expect(total).toHaveText('4h · 1 entries');
    await page.getByRole('radio', { name: 'Internal' }).click();
    await expect(total).toHaveText('0h · 0 entries');
    await expect(screen(page, 'history')).toContainText('No entries match these filters.');
    await page.getByRole('radio', { name: 'All', exact: true }).click();
    await expect(total).toHaveText('25h · 17 entries');
    // filters persist
    await page.reload();
    await expectScreen(page, 'history');
    await expect(byTestId(page, 'history-total')).toHaveText('25h · 17 entries');
  });

  test('M-42 Download CSV saves timesheet-{name}.csv with the filtered rows', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/history');
    await page.getByRole('radio', { name: 'Daco intranet' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'history-download').click()]);
    expect(download.suggestedFilename()).toBe('timesheet-chary.csv');
    const path = await download.path();
    const fs = await import('node:fs');
    const csv = fs.readFileSync(path, 'utf8');
    expect(csv.split('\n')).toEqual(['Date,Work,Project,Hours,Type', '2026-10-08,"DIN-5 · Single sign-on with Azure AD",Daco intranet,4,Billable']);
    await expect(toast(page)).toHaveText('CSV downloaded');
  });

  test('M-42 entries logged in the app show up in history', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTime(page);
    await openLog(page);
    await pick(page, 'Project', 'Internal');
    await sheet(page, 'log-time').getByLabel('What did you work on?').fill('Team lunch');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toBeVisible();
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-history').click();
    await expect(byTestId(page, 'history-total')).toHaveText('142h 30m · 41 entries');
    const first = screen(page, 'history').getByTestId('history-day').first();
    await expect(first).toContainText('Sat 10 Oct');
    await expect(first).toContainText('Team lunch');
  });
});

// ── Leave ──────────────────────────────────────────────────────────────────

test.describe('leave', () => {
  test('M-35 request leave: errors, then a pending row and a toast', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-leave').click();
    await expectScreen(page, 'leave');
    await expect(screen(page, 'leave')).toContainText('My requests');
    await expect(screen(page, 'leave')).not.toContainText('Waiting for your approval');
    await expect(byTestId(page, 'leave-mine-2')).toContainText('Comp-off · 4 Oct');
    await expect(byTestId(page, 'leave-mine-2')).toContainText('Pending');
    await byTestId(page, 'action-new-leave').click();
    const s = sheet(page, 'leave');
    await expect(s).toBeVisible();
    await expect(s.getByLabel('From')).toHaveValue('2026-10-17');
    await expect(s.getByLabel('To')).toHaveValue('2026-10-17');
    await page.getByTestId('leave-save').click();
    await expect(s.getByTestId('form-error')).toHaveText('Add a reason.');
    await s.getByLabel('Reason').fill('Wedding');
    await expect(s.getByTestId('form-error')).toHaveCount(0);
    await s.getByLabel('From').fill('2026-10-21');
    await s.getByLabel('To').fill('2026-10-20');
    await page.getByTestId('leave-save').click();
    await expect(s.getByTestId('form-error')).toHaveText('The end date is before the start date.');
    await s.getByLabel('To').fill('2026-10-23');
    await page.getByTestId('leave-save').click();
    await expect(sheet(page, 'leave')).toHaveCount(0);
    await expect(toast(page)).toHaveText('Request sent for approval');
    const rows = screen(page, 'leave').locator('[data-testid^="leave-mine-"]');
    await expect(rows).toHaveCount(4);
    // newest start date first: 24 Oct, then the new 21 Oct request
    const added = rows.nth(1);
    await expect(added).toContainText('Leave · 21 Oct – 23 Oct');
    await expect(added).toContainText('3 days · Wedding');
    await expect(added).toContainText('Pending');
  });

  test('M-35 comp-off labels the first date "Day worked"', async ({ page }) => {
    await signInAs(page, 'devops');
    await page.goto('/leave');
    await byTestId(page, 'action-new-leave').click();
    const s = sheet(page, 'leave');
    await s.getByRole('tab', { name: 'Comp-off' }).click();
    await expect(s.getByLabel('Day worked')).toBeVisible();
    await expect(s.getByLabel('Reason')).toHaveAttribute('placeholder', 'What did you work on that day?');
    await s.getByLabel('Reason').fill('Sunday migration');
    await page.getByTestId('leave-save').click();
    await expect(toast(page)).toHaveText('Request sent for approval');
    await expect(screen(page, 'leave')).toContainText('Comp-off · 17 Oct');
  });

  test('M-35 freelancers get no New button', async ({ page }) => {
    await signInAs(page, 'free');
    await page.goto('/leave');
    await expectScreen(page, 'leave');
    await expect(byTestId(page, 'action-new-leave')).toHaveCount(0);
  });

  test('M-36 approve and reject: cards leave the list, the requester sees the result', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-leave').click();
    await expectScreen(page, 'leave');
    const pending = screen(page, 'leave').locator('[data-testid^="leave-pending-"]');
    await expect(pending).toHaveCount(3);
    await expect(byTestId(page, 'leave-pending-2')).toContainText('Comp-off · 4 Oct · 1 day');
    await expect(byTestId(page, 'leave-pending-6')).toContainText('Leave · 3 Nov – 5 Nov · 3 days');
    await expect(byTestId(page, 'leave-mine-4')).toContainText('Diwali');
    await byTestId(page, 'leave-approve-2').click();
    await expect(toast(page)).toHaveText('Request approved');
    await expect(pending).toHaveCount(2);
    await byTestId(page, 'leave-reject-6').click();
    await expect(toast(page)).toHaveText('Request rejected');
    await expect(pending).toHaveCount(1);
    await byTestId(page, 'leave-approve-5').click();
    await expect(pending).toHaveCount(0);
    await expect(byTestId(page, 'leave-caught-up')).toHaveText('All caught up.');
    await goTab(page, 'more');
    await expect(byTestId(page, 'more-tile-leave')).toContainText('0 to approve');

    // Chary sees the approved comp-off (store survives switching accounts).
    await byTestId(page, 'more-switch-account').click();
    await page.getByTestId('account-dev').click();
    await expectScreen(page, 'home');
    await page.goto('/leave');
    await expect(byTestId(page, 'leave-mine-2')).toContainText('Approved');
  });
});

// ── Team ───────────────────────────────────────────────────────────────────

test.describe('team hours', () => {
  test('M-39 team hours: totals, rows, week browsing', async ({ page }) => {
    await signInAs(page, 'admin');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-team').click();
    await expectScreen(page, 'team');
    await expect(byTestId(page, 'team-total-logged')).toContainText('202h');
    await expect(byTestId(page, 'team-total-billable')).toContainText('150h 30m');
    await expect(byTestId(page, 'team-total-idle')).toContainText('22h');
    const rows = screen(page, 'team').locator('[data-testid^="team-row-"]');
    await expect(rows).toHaveCount(6);
    await expect(byTestId(page, 'team-row-Rahul')).toContainText('Super admin · 40h');
    await expect(byTestId(page, 'team-row-Rahul').getByTestId('team-idle')).toHaveText('Idle 6h');
    await expect(byTestId(page, 'team-row-Arjun')).toContainText('Freelancer · No target');
    await expect(byTestId(page, 'team-row-Arjun').getByTestId('team-idle')).toHaveText('Idle —');
    await expect(byTestId(page, 'team-row-Chary').getByTestId('team-logged')).toHaveText('37h 30m');
    const next = byTestId(page, 'week-next');
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await byTestId(page, 'week-prev').click();
    await expect(byTestId(page, 'week-range')).toContainText('28 Sep – 4 Oct');
    await expect(byTestId(page, 'team-total-logged')).not.toContainText('202h');
    await next.click();
    await expect(byTestId(page, 'team-total-logged')).toContainText('202h');
  });

  test('M-39 time logged in the app shows in Team hours (single source with Home)', async ({ page }) => {
    await signInAs(page, 'pm');
    await openTime(page);
    await openLog(page);
    await pick(page, 'Project', 'Daco platform');
    await pick(page, 'Ticket', { label: 'PMT-20 · Ticket import' });
    await pick(page, 'Hours', '2');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('Logged 2h on PMT-20');
    await page.goto('/team');
    await expect(byTestId(page, 'team-row-Vivek').getByTestId('team-logged')).toHaveText('38h');
    await expect(byTestId(page, 'team-total-logged')).toContainText('204h');
  });
});

test('every P2 pressable has an accessible name', async ({ page }) => {
  await signInAs(page, 'admin');
  const check = async () =>
    expect(await page.locator('[role=button]:not([aria-label]), [role=tab]:not([aria-label]), [role=switch]:not([aria-label])').count()).toBe(0);
  for (const url of ['/time', '/more', '/me', '/history', '/leave', '/team', '/sheet/log-time', '/sheet/leave']) {
    await page.goto(url);
    await expect(page.locator('[data-testid^="screen-"], [data-testid^="sheet-"]').filter({ visible: true }).first()).toBeVisible();
    await check();
  }
});
