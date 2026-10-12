import { expect, test, type Page } from '@playwright/test';

import { ACCOUNT_KEYS, byTestId, expectScreen, goTab, headerTitle, openRoute, selectedTab, signInAs, toast, type AccountKey } from '../helpers/session';

/**
 * W1: Dashboard, search, my tickets, ticket, subtask and new ticket (SPEC S5-DASH,
 * S5-SEARCH, S5-MYTICKETS, S5-TICKET, S5-SUB, SH-NEWTICKET). Every W1 flow V-xx has a
 * test whose title starts with its id.
 */

const KPIS: Record<AccountKey, string[]> = {
  super: ['Active projects', 'Logged this month', 'Idle time', 'Critical open'],
  admin: ['Pending leave', 'Holiday & personal', 'Team idle this week', 'Overdue tickets'],
  pm: ['Active sprint', 'Sprint done', 'Due this week', 'Questions waiting'],
  dev: ['My open tickets', 'Due this week', 'Logged this week', 'Idle this week'],
  freelancer: ['My open tickets', 'Due this week', 'Logged this week', 'Billable this week'],
  devops: ['Open requests', 'Projects in setup', 'Due this week', 'Logged this week'],
  cadmin: ['Projects', 'Overall progress', 'Next delivery', 'Questions for you'],
  cuser: ['Questions for you', 'My open bugs', 'Next delivery', 'Sprint progress'],
};

const WIDGETS: Record<AccountKey, string[]> = {
  super: ['Budget vs hours used', 'Epic progress', 'Team hours this week', 'DevOps status', 'Client questions waiting', 'Leave & attendance'],
  admin: ['Approvals', 'Hours by employee', 'Overdue tickets', 'DevOps status', 'Team hours this week'],
  pm: ['Active sprints', 'Tickets due this week', 'Budget vs hours used', 'Client questions waiting', 'Team load'],
  dev: ['My tickets', 'My week', 'My active projects', 'My sprint', 'Questions on my tickets'],
  freelancer: ['My tickets', 'My week', 'My active projects', 'My sprint', 'Questions on my tickets'],
  devops: ['Infra status', 'DevOps requests', 'Waiting for client', 'My week'],
  cadmin: ['Epic progress', 'Questions waiting for you', 'Bugs reported', 'Go-live readiness'],
  cuser: ['Questions waiting for you', 'My bugs', 'Current sprint', 'Recently delivered'],
};

const SCOPE: Record<AccountKey, string> = {
  super: 'Everything across Viljetech and all client companies',
  admin: 'Viljetech team, projects and approvals',
  pm: 'Daco and Nordlys projects you manage',
  dev: 'Your tickets and time',
  freelancer: 'Your tickets and time',
  devops: 'Infra, environments and DevOps requests',
  cadmin: 'Daco · all projects and colleagues',
  cuser: 'Daco platform',
};

const home = (page: Page) => byTestId(page, 'screen-home');
const ticketScreen = (page: Page) => byTestId(page, 'screen-ticket');
const subScreen = (page: Page) => byTestId(page, 'screen-subtask');

async function openTicket(page: Page, key: string) {
  await openRoute(page, `/ticket/${key}`);
  await expect(ticketScreen(page)).toBeVisible();
  await expect(headerTitle(page)).toHaveText(key);
}

test.describe('Dashboard (S5-DASH)', () => {
  for (const k of ACCOUNT_KEYS) {
    test(`V-07 ${k}: scope line, KPI labels and widget titles`, async ({ page }) => {
      await signInAs(page, k);
      await expect(headerTitle(page)).toHaveText('Dashboard');
      await expect(byTestId(page, 'header-sub')).toHaveText(SCOPE[k]);
      const kpis = byTestId(page, 'dash-kpis');
      for (const l of KPIS[k]) await expect(kpis.getByText(l, { exact: true })).toBeVisible();
      const s = home(page);
      for (const w of WIDGETS[k]) await expect(s.getByText(w, { exact: true }).first()).toBeAttached();
      if (k === 'cadmin' || k === 'cuser') await expect(byTestId(page, 'dash-log-time')).toHaveCount(0);
      else await expect(byTestId(page, 'dash-log-time')).toBeVisible();
    });
  }

  test('V-07 KPI tile and link chips drill down with tab2 (tab or push)', async ({ page }) => {
    await signInAs(page, 'super');
    // KPI "Critical open" → Tickets tab
    await byTestId(page, 'dash-kpi-3').click();
    await expectScreen(page, 'tickets');
    expect(await selectedTab(page)).toBe('Tickets');
    await goTab(page, 'home');
    // "Employee timesheets ›" is not a tab → pushed, Home stays highlighted
    await byTestId(page, 'dash-link-team-week').click();
    await expectScreen(page, 'emp');
    expect(await selectedTab(page)).toBe('Home');
    await byTestId(page, 'header-back').click();
    // a progress row opens the project
    await byTestId(page, 'dash-w-budget').getByText('Daco · Daco platform').click();
    await expectScreen(page, 'project');
  });

  test('V-07 dev: My tickets widget rows open the ticket; numbers are live', async ({ page }) => {
    await signInAs(page, 'dev');
    const kpi = byTestId(page, 'dash-kpi-0');
    await expect(kpi).toContainText('6');
    await byTestId(page, 'dash-w-tix').getByTestId('ticket-row-PMT-11').click();
    await expect(ticketScreen(page)).toBeVisible();
    await byTestId(page, 'tf-st').click();
    await byTestId(page, 'sheet-tfield').getByTestId('pick-done').click();
    await goTab(page, 'home');
    await expect(byTestId(page, 'dash-kpi-0')).toContainText('5');
  });

  test('V-05 switching tabs from the dashboard resets the stack', async ({ page }) => {
    await signInAs(page, 'pm');
    await byTestId(page, 'dash-link-due').click();
    await expectScreen(page, 'tickets');
    await byTestId(page, 'ticket-row-NRD-4').first().click();
    await expect(ticketScreen(page)).toBeVisible();
    await goTab(page, 'home');
    await expect(byTestId(page, 'header-back')).toHaveCount(0);
    await goTab(page, 'tickets');
    await expect(byTestId(page, 'header-back')).toHaveCount(0);
  });

  test('V-07 devops: a request row opens the request', async ({ page }) => {
    await signInAs(page, 'devops');
    await byTestId(page, 'dash-requests-row-0').click();
    await expectScreen(page, 'request');
  });
});

test.describe('Search (S5-SEARCH)', () => {
  test('V-06 search groups, results and empty state', async ({ page }) => {
    await signInAs(page, 'super');
    await byTestId(page, 'header-search').click();
    await expectScreen(page, 'search');
    await expect(byTestId(page, 'screen-search').getByText('Search pages, tickets, projects, companies and people.')).toBeVisible();
    await byTestId(page, 'search-field').fill('daco');
    await expect(byTestId(page, 'search-project-dacop')).toBeVisible();
    // DevOps results are titled with the project name (SPEC 2.6)
    await expect(byTestId(page, 'search-devops-OPS-101')).toContainText('Daco platform');
    await expect(byTestId(page, 'search-devops-OPS-101')).not.toContainText('Daco · Daco platform');
    await expect(byTestId(page, 'search-company-daco')).toBeVisible();
    await expect(byTestId(page, 'search-person-7')).toBeVisible();
    await byTestId(page, 'search-field').fill('zzzz');
    await expect(byTestId(page, 'search-empty')).toHaveText('No results for “zzzz”');
    await byTestId(page, 'search-field').fill('PMT-11');
    await byTestId(page, 'search-tickets').getByTestId('ticket-row-PMT-11').click();
    await expect(ticketScreen(page)).toBeVisible();
  });

  test('V-06 a page result uses tab2; a project result is pushed', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'header-search').click();
    await byTestId(page, 'search-field').fill('time');
    await byTestId(page, 'search-page-time').click();
    await expectScreen(page, 'time');
    expect(await selectedTab(page)).toBe('Time');
    // dev has no Users access: no People group
    await byTestId(page, 'header-search').click();
    await byTestId(page, 'search-field').fill('chary');
    await expect(byTestId(page, 'search-people')).toHaveCount(0);
  });

  test('V-06 devops: DevOps group by project name, no tickets', async ({ page }) => {
    await signInAs(page, 'devops');
    await byTestId(page, 'header-search').click();
    await byTestId(page, 'search-field').fill('fast');
    await expect(byTestId(page, 'search-devops-OPS-106')).toContainText('Fast');
    await expect(byTestId(page, 'search-tickets')).toHaveCount(0);
    await byTestId(page, 'search-devops-OPS-106').click();
    await expectScreen(page, 'dvp');
  });
});

test.describe('My tickets (S5-MYTICKETS)', () => {
  test('V-30 segments and grouping', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'tickets');
    await expect(byTestId(page, 'header-sub')).toHaveText('6 open');
    await expect(byTestId(page, 'seg-now')).toContainText('5');
    await expect(byTestId(page, 'group-Overdue')).toContainText('2 tickets');
    await expect(byTestId(page, 'group-Today')).toBeVisible();
    await byTestId(page, 'seg-crit').click();
    await expect(byTestId(page, 'group-Overdue')).toContainText('1 ticket');
    await expect(byTestId(page, 'ticket-row-PMT-20')).toHaveCount(0);
    await byTestId(page, 'seg-all').click();
    await byTestId(page, 'chip-proj').click();
    await expect(byTestId(page, 'group-Daco platform')).toBeVisible();
    await expect(byTestId(page, 'group-Business portal')).toContainText('1 ticket');
    await byTestId(page, 'chip-sprint').click();
    await expect(byTestId(page, 'group-Mobile app · Sprint 2')).toBeVisible();
    await expect(byTestId(page, 'my-sprints')).toContainText('of my tasks done');
    await expect(byTestId(page, 'my-epics')).toContainText('Mobile app');
  });

  test('V-30 empty filter shows the empty state', async ({ page }) => {
    await signInAs(page, 'freelancer');
    await goTab(page, 'tickets');
    await byTestId(page, 'seg-crit').click();
    await expect(byTestId(page, 'tickets-empty')).toHaveText('No tickets match these filters.');
  });
});

test.describe('Ticket (S5-TICKET)', () => {
  test('V-20 opening a ticket clears its unread badge', async ({ page }) => {
    await signInAs(page, 'dev');
    await expect(page.getByTestId('tab-tickets')).toContainText('3');
    await goTab(page, 'tickets');
    await byTestId(page, 'ticket-row-PMT-11').click();
    await expect(ticketScreen(page)).toBeVisible();
    await expect(page.getByTestId('tab-tickets')).toContainText('1');
    await expect(page.getByTestId('tab-tickets')).not.toContainText('3');
  });

  test('V-21 change status, priority, sprint, due and estimate', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-12');
    // status from the hero badge
    await byTestId(page, 'ticket-hero-status').click();
    await expect(page.getByTestId('sheet-tfield')).toContainText('Status');
    await page.getByTestId('sheet-tfield').getByTestId('pick-review').click();
    await expect(toast(page)).toHaveText('Moved to Review');
    await expect(byTestId(page, 'tf-st')).toContainText('Review');
    // priority
    await byTestId(page, 'tf-prio').click();
    await page.getByTestId('sheet-tfield').getByTestId('pick-High').click();
    await expect(byTestId(page, 'tf-prio')).toContainText('High');
    // sprint → backlog
    await byTestId(page, 'tf-sprint').click();
    await page.getByTestId('sheet-tfield').getByTestId('pick-none').click();
    await expect(byTestId(page, 'tf-sprint')).toContainText('Backlog');
    // due date
    await byTestId(page, 'tf-due').click();
    await page.getByTestId('sheet-tfield').getByTestId('field-value').fill('2026-10-20');
    await page.getByTestId('sheet-tfield').getByTestId('field-save').click();
    await expect(byTestId(page, 'tf-due')).toContainText('Tue 20 Oct');
    // estimate: set then clear
    await byTestId(page, 'tf-est').click();
    await page.getByTestId('sheet-tfield').getByTestId('field-value').fill('9');
    await page.getByTestId('sheet-tfield').getByTestId('field-save').click();
    await expect(byTestId(page, 'tf-est')).toContainText('9h');
    await byTestId(page, 'tf-est').click();
    await page.getByTestId('sheet-tfield').getByTestId('field-clear').click();
    await expect(byTestId(page, 'tf-est')).toContainText('—');
  });

  test('V-21 dev without tickets.assign cannot change assignees', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-12');
    await expect(byTestId(page, 'tf-as')).not.toHaveAttribute('role', 'button');
    await expect(byTestId(page, 'tf-st')).toHaveAttribute('role', 'button');
    await byTestId(page, 'tf-as').click();
    await expect(page.getByTestId('sheet-tfield')).toHaveCount(0);
  });

  test('V-21 pm with tickets.assign changes assignees', async ({ page }) => {
    await signInAs(page, 'pm');
    await openTicket(page, 'PMT-12');
    await byTestId(page, 'tf-as').click();
    await expect(page.getByTestId('sheet-tfield')).toContainText('Assignees');
    await page.getByTestId('sheet-tfield').getByTestId('assignee-Sofia').click();
    await page.getByTestId('sheet-tfield').getByTestId('field-save').click();
    await expect(byTestId(page, 'tf-as')).toContainText('Chary, Rahul, Sofia');
  });

  test('V-22 edit the description', async ({ page }) => {
    await signInAs(page, 'super');
    await openTicket(page, 'PMT-16');
    await byTestId(page, 'desc-edit').click();
    await page.getByTestId('sheet-tdesc').getByTestId('desc-input').fill('Cache the last 50 tasks and their photos.');
    await page.getByTestId('sheet-tdesc').getByTestId('desc-save').click();
    await expect(page.getByTestId('sheet-tdesc')).toHaveCount(0);
    await expect(byTestId(page, 'ticket-desc')).toHaveText('Cache the last 50 tasks and their photos.');
  });

  test('V-23 add a subtask', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await expect(byTestId(page, 'ticket-subtasks')).toContainText('1 of 3 done');
    await byTestId(page, 'sub-add-input').fill('Retry on token expiry');
    await byTestId(page, 'sub-add').click();
    await expect(toast(page)).toHaveText('Subtask added');
    await expect(byTestId(page, 'sub-row-PMT-11.s4')).toContainText('PMT-11.4');
    await expect(byTestId(page, 'ticket-subtasks')).toContainText('1 of 4 done');
    await expect(byTestId(page, 'sub-add-input')).toHaveValue('');
  });

  test('V-24 complete and reopen a subtask from the ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await byTestId(page, 'sub-row-PMT-11.s2-check').click();
    await expect(toast(page)).toHaveText('Completed PMT-11.2');
    await expect(byTestId(page, 'ticket-subtasks')).toContainText('2 of 3 done');
    await expect(byTestId(page, 'sub-progress')).toContainText('67%');
    await byTestId(page, 'sub-row-PMT-11.s2-check').click();
    await expect(toast(page)).toHaveText('Reopened PMT-11.2');
  });

  test('V-27 link and clear a blocker', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await expect(byTestId(page, 'ticket-blocked')).toContainText('Nothing');
    await byTestId(page, 'link-open').click();
    await expect(page.getByTestId('sheet-tlink')).toContainText('Pick the task that blocks PMT-11');
    await page.getByTestId('sheet-tlink').getByTestId('link-PMT-10').click();
    await expect(byTestId(page, 'blk-PMT-10')).toBeVisible();
    await byTestId(page, 'link-open').click();
    await expect(page.getByTestId('sheet-tlink').getByTestId('link-PMT-10')).toHaveCount(0);
    await page.getByTestId('sheet-tlink').getByTestId('link-clear').click();
    await expect(byTestId(page, 'ticket-blocked')).toContainText('Nothing');
  });

  test('V-28 attach a file', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-12');
    await expect(byTestId(page, 'ticket-attachments')).toContainText('No attachments.');
    await page.getByTestId('attach-input').setInputFiles({ name: 'profile-mock.png', mimeType: 'image/png', buffer: Buffer.alloc(3000) });
    await expect(toast(page)).toHaveText('Attachment added');
    await expect(byTestId(page, 'ticket-attachments')).toContainText('profile-mock.png');
    await expect(byTestId(page, 'ticket-attachments')).toContainText('3 KB · 10 Oct');
  });

  test('V-29 comment on a ticket (send disabled while empty)', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-10');
    await expect(byTestId(page, 'ticket-comments-send')).toBeDisabled();
    await byTestId(page, 'ticket-comments-input').fill('Staging works with the test environment.');
    await byTestId(page, 'ticket-comments-send').click();
    await expect(byTestId(page, 'ticket-comments')).toContainText('Chary · just now');
    await expect(byTestId(page, 'ticket-comments')).toContainText('Staging works with the test environment.');
    await expect(byTestId(page, 'ticket-comments-input')).toHaveValue('');
  });

  test('V-29 a client sees the read-only ticket and can comment', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await openTicket(page, 'PMT-11');
    await expect(ticketScreen(page)).toContainText('Only comments can be added from the portal. The team updates status and dates.');
    await expect(byTestId(page, 'ticket-hero')).toContainText('Being fixed');
    await expect(byTestId(page, 'tf-st')).not.toHaveAttribute('role', 'button');
    await expect(byTestId(page, 'tf-sprint')).toHaveCount(0);
    await expect(byTestId(page, 'tf-logged')).toHaveCount(0);
    await expect(byTestId(page, 'desc-edit')).toHaveCount(0);
    await expect(byTestId(page, 'ticket-blocked')).toHaveCount(0);
    await expect(byTestId(page, 'ticket-time')).toHaveCount(0);
    await expect(byTestId(page, 'sub-add')).toHaveCount(0);
    await byTestId(page, 'ticket-comments-input').fill('Thanks, we will test on Monday.');
    await byTestId(page, 'ticket-comments-send').click();
    await expect(byTestId(page, 'ticket-comments')).toContainText('Ingrid Solberg · just now');
  });

  test('V-10 entry: ticket Time "Log" opens SH-LOG preset with the ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await byTestId(page, 'ticket-log').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page).toHaveURL(/proj=c%3Adacop/);
    await expect(page).toHaveURL(/key=PMT-11/);
  });
});

test.describe('Subtask (S5-SUB)', () => {
  test('V-25 subtask fields, notes, comment and prev/next', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await byTestId(page, 'sub-row-PMT-11.s2').click();
    await expect(subScreen(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveText('PMT-11.2');
    await expect(byTestId(page, 'sub-hero')).toContainText('PMT-11.2 · Subtask 2 of 3');
    // status
    await byTestId(page, 'sf-st').click();
    await page.getByTestId('sheet-sfield').getByTestId('pick-prog').click();
    await expect(byTestId(page, 'sf-st')).toContainText('In progress');
    // assignee (single)
    await byTestId(page, 'sf-as').click();
    await page.getByTestId('sheet-sfield').getByTestId('pick-Sofia').click();
    await expect(byTestId(page, 'sf-as')).toContainText('Sofia');
    // due
    await byTestId(page, 'sf-due').click();
    await page.getByTestId('sheet-sfield').getByTestId('field-value').fill('2026-10-08');
    await page.getByTestId('sheet-sfield').getByTestId('field-save').click();
    await expect(byTestId(page, 'sf-due')).toContainText('Thu 8 Oct');
    await expect(byTestId(page, 'sub-hero')).toContainText('Overdue 8 Oct');
    // estimate
    await byTestId(page, 'sf-est').click();
    await page.getByTestId('sheet-sfield').getByTestId('field-value').fill('3');
    await page.getByTestId('sheet-sfield').getByTestId('field-save').click();
    await expect(byTestId(page, 'sf-time')).toContainText('0h / 3h');
    // notes
    await byTestId(page, 'note-edit').click();
    await page.getByTestId('sheet-snote').getByTestId('note-input').fill('Only Android 14 devices.');
    await page.getByTestId('sheet-snote').getByTestId('note-save').click();
    await expect(byTestId(page, 'sub-note')).toHaveText('Only Android 14 devices.');
    // comment
    await byTestId(page, 'sub-comments-input').fill('Repro on Pixel 8.');
    await byTestId(page, 'sub-comments-send').click();
    await expect(byTestId(page, 'sub-comments')).toContainText('Repro on Pixel 8.');
    // previous / next step in place
    await byTestId(page, 'sub-next').click();
    await expect(headerTitle(page)).toHaveText('PMT-11.3');
    await expect(byTestId(page, 'sub-next')).toBeDisabled();
    await byTestId(page, 'sub-prev').click();
    await byTestId(page, 'sub-prev').click();
    await expect(headerTitle(page)).toHaveText('PMT-11.1');
    await expect(byTestId(page, 'sub-prev')).toBeDisabled();
    // the ticket row reflects the subtask changes
    await byTestId(page, 'sub-row-PMT-11.s2').click();
    await expect(headerTitle(page)).toHaveText('PMT-11.2');
    await expect(byTestId(page, 'sub-row-PMT-11.s2')).toContainText('Sofia');
  });

  test('V-24 Mark done / Done · reopen on the subtask screen', async ({ page }) => {
    await signInAs(page, 'dev');
    await openRoute(page, '/subtask/PMT-12.s1');
    await expect(subScreen(page)).toBeVisible();
    await byTestId(page, 'sub-done').click();
    await expect(toast(page)).toHaveText('Marked done');
    await expect(byTestId(page, 'sub-done')).toHaveText('Done · reopen');
    await byTestId(page, 'sub-done').click();
    await expect(toast(page)).toHaveText('Reopened');
  });

  test('V-26 delete a subtask with confirm (logged time is kept)', async ({ page }) => {
    await signInAs(page, 'dev');
    await openTicket(page, 'PMT-11');
    await byTestId(page, 'sub-row-PMT-11.s2').click();
    await byTestId(page, 'sub-delete').click();
    const confirm = page.getByTestId('sheet-delete-subtask');
    await expect(confirm).toContainText('Delete PMT-11.2?');
    await expect(confirm).toContainText('“Android token refresh” is removed from PMT-11. Logged time is kept.');
    await confirm.getByTestId('sheet-delete-subtask-cancel').click();
    await expect(subScreen(page)).toBeVisible();
    await byTestId(page, 'sub-delete').click();
    await page.getByTestId('sheet-delete-subtask-ok').click();
    await expect(toast(page)).toHaveText('Subtask deleted');
    await expect(ticketScreen(page)).toBeVisible();
    await expect(byTestId(page, 'ticket-subtasks')).toContainText('1 of 2 done');
    // the stable id of the old third subtask is kept; its key is now PMT-11.2
    await expect(byTestId(page, 'sub-row-PMT-11.s3')).toContainText('PMT-11.2');
    await expect(byTestId(page, 'sub-row-PMT-11.s2')).toHaveCount(0);
  });

  test('V-25 the subtask Time "Log" presets the stable subtask id', async ({ page }) => {
    await signInAs(page, 'dev');
    await openRoute(page, '/subtask/PMT-11.s2');
    await byTestId(page, 'sub-log').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page).toHaveURL(/key=PMT-11\.s2/);
  });
});

test.describe('New ticket (SH-NEWTICKET)', () => {
  test('V-31 create a ticket from a project', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/sheet/new-ticket?pid=dacop');
    const sheet = page.getByTestId('sheet-new-ticket');
    await expect(sheet).toContainText('Create ticket');
    await expect(sheet).toContainText('Daco platform');
    await sheet.getByTestId('nt-save').click();
    await expect(sheet.getByTestId('field-error')).toHaveText('Required');
    await sheet.getByTestId('nt-title').fill('Dark mode');
    await sheet.getByTestId('nt-type-Story').click();
    await sheet.getByTestId('nt-epic').selectOption('web');
    await sheet.getByTestId('nt-sprint').selectOption('w4');
    await sheet.getByTestId('nt-prio-High').click();
    await sheet.getByTestId('nt-as-Sofia').click();
    await sheet.getByTestId('nt-due').fill('2026-10-23');
    await sheet.getByTestId('nt-est').fill('5');
    await sheet.getByTestId('nt-save').click();
    await expect(toast(page)).toHaveText('PMT-32 created');
    await expect(page.getByTestId('sheet-new-ticket')).toHaveCount(0);
    await openTicket(page, 'PMT-32');
    await expect(byTestId(page, 'ticket-hero')).toContainText('PMT-32 · Story');
    await expect(byTestId(page, 'ticket-hero')).toContainText('Daco platform · Web app');
    await expect(byTestId(page, 'tf-sprint')).toContainText('Sprint 4');
    await expect(byTestId(page, 'tf-as')).toContainText('Sofia');
    await expect(byTestId(page, 'tf-est')).toContainText('5h');
  });

  test('V-31 the internal project uses the INT prefix (A-13)', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/sheet/new-ticket?pid=i1');
    const sheet = page.getByTestId('sheet-new-ticket');
    await sheet.getByTestId('nt-title').fill('Rule editor');
    await sheet.getByTestId('nt-save').click();
    await expect(toast(page)).toHaveText('INT-6 created');
  });
});
