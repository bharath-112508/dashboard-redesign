import { expect, test, type Page } from '@playwright/test';

import { byTestId, expectScreen, goTab, screen, selectedTab, signInAs, tabBar } from '../helpers/session';

/** P1: Home, Tickets and Notifications (SPEC S-HOME, S-TICKETS, S-TICKET, S-BOARD, S-INBOX). */

const kpi = (page: Page, slug: string) => byTestId(page, `home-kpi-${slug}`);

async function back(page: Page) {
  await byTestId(page, 'header-back').click();
}

test.describe('M-44 Home variants and navigation', () => {
  test('M-44 dev home: greeting, KPIs, Needs you now, week card, carousel', async ({ page }) => {
    await signInAs(page, 'dev');
    await expect(byTestId(page, 'home-greeting')).toHaveText(/^Good (morning|afternoon|evening), Chary · Sat 10 Oct$/);
    await expect(byTestId(page, 'home-ic')).toBeVisible();
    await expect(kpi(page, 'open-tickets')).toHaveAttribute('aria-label', 'Open tickets: 6');
    await expect(kpi(page, 'open-tickets')).toContainText('Across 2 projects');
    await expect(kpi(page, 'critical')).toHaveAttribute('aria-label', 'Critical: 1');
    await expect(kpi(page, 'overdue')).toHaveAttribute('aria-label', 'Overdue: 2');
    await expect(kpi(page, 'logged-this-week')).toContainText('29h');
    await expect(kpi(page, 'logged-this-week')).toContainText('of 40h');

    const list = byTestId(page, 'home-list-now');
    await expect(list).toContainText('Needs you now');
    await expect(list.locator('[data-testid^="home-row-"]')).toHaveCount(2);
    await expect(byTestId(page, 'home-row-pmt-11')).toContainText('Critical');
    await expect(byTestId(page, 'home-row-pmt-11')).toContainText('3d late');
    await expect(byTestId(page, 'home-row-pmt-20')).toContainText('1d late');

    await expect(byTestId(page, 'home-week')).toContainText('5 – 9 Oct');
    await expect(byTestId(page, 'home-week-total')).toHaveText('29h / 40h');
    await expect(byTestId(page, 'home-week')).toContainText('Idle');
    await expect(byTestId(page, 'home-project-daco-platform')).toContainText('5 open tickets');
    await expect(byTestId(page, 'home-project-daco-intranet')).toContainText('1 open ticket');
    await expect(byTestId(page, 'home-team')).toHaveCount(0);
  });

  test('M-44 dev home: tiles, links, rows, week card and carousel navigate', async ({ page }) => {
    await signInAs(page, 'dev');
    await kpi(page, 'open-tickets').click();
    await expectScreen(page, 'tickets');
    await goTab(page, 'home');
    await kpi(page, 'logged-this-week').click();
    await expectScreen(page, 'time');
    await goTab(page, 'home');
    await byTestId(page, 'home-list-now').getByRole('link', { name: 'My tickets' }).click();
    await expectScreen(page, 'tickets');
    await goTab(page, 'home');
    await byTestId(page, 'home-row-pmt-11').click();
    await expectScreen(page, 'ticket');
    await back(page);
    await expectScreen(page, 'home');
    await byTestId(page, 'home-week').click();
    await expectScreen(page, 'time');
    await goTab(page, 'home');
    await byTestId(page, 'home-project-daco-platform').click();
    await expectScreen(page, 'project');
    expect(await selectedTab(page)).toBe('Home');
    await back(page);
    await screen(page, 'home').getByRole('link', { name: 'See all' }).click();
    await expectScreen(page, 'projects');
  });

  test('M-44 freelancer home: hours logged, no idle, no 40h target', async ({ page }) => {
    await signInAs(page, 'free');
    await expect(kpi(page, 'logged-this-week')).toContainText('Hours logged');
    await expect(byTestId(page, 'home-week-total')).not.toContainText('/ 40h');
    await expect(byTestId(page, 'home-week')).not.toContainText('Idle');
  });

  test('M-44 pm home: KPIs, attention, approvals, team hours', async ({ page }) => {
    await signInAs(page, 'pm');
    await expect(byTestId(page, 'home-staffAll')).toBeVisible();
    await expect(kpi(page, 'active-projects')).toHaveAttribute('aria-label', 'Active projects: 5');
    await expect(kpi(page, 'active-projects')).toContainText('Across 4 companies');
    await expect(kpi(page, 'critical-open')).toHaveAttribute('aria-label', 'Critical open: 2');
    await expect(kpi(page, 'overdue-tickets')).toHaveAttribute('aria-label', 'Overdue tickets: 2');
    await expect(byTestId(page, 'home-list-attention').locator('[data-testid^="home-row-"]')).toHaveCount(3);
    const approvals = byTestId(page, 'home-list-approvals');
    await expect(approvals).toContainText('Waiting for approval');
    const n = await approvals.locator('[data-testid^="home-row-"]').count();
    expect(n).toBeGreaterThan(0);
    await expect(kpi(page, 'approvals')).toHaveAttribute('aria-label', `Approvals: ${n}`);
    await expect(byTestId(page, 'home-team')).toBeVisible();
    await expect(byTestId(page, 'home-team-arjun')).toContainText('Freelancer');
    await expect(byTestId(page, 'home-project-nordlys-portal')).toBeVisible();
    await expect(byTestId(page, 'home-project-fjordline-app')).toBeVisible();

    await approvals.getByRole('link', { name: 'Review' }).click();
    await expectScreen(page, 'leave');
    await back(page);
    await kpi(page, 'approvals').click();
    await expectScreen(page, 'leave');
    await back(page);
    await kpi(page, 'active-projects').click();
    await expectScreen(page, 'projects');
    await goTab(page, 'home');
    await byTestId(page, 'home-list-attention').getByRole('link', { name: 'All tickets' }).click();
    await expectScreen(page, 'tickets');
  });

  test('M-44 super home uses the staffAll layout', async ({ page }) => {
    await signInAs(page, 'super');
    await expect(byTestId(page, 'home-staffAll')).toBeVisible();
    await expect(byTestId(page, 'home-team')).toBeVisible();
  });

  test('M-44 devops home: setup KPIs and reminders, no carousel', async ({ page }) => {
    await signInAs(page, 'devops');
    await expect(byTestId(page, 'home-devops')).toBeVisible();
    await expect(kpi(page, 'projects-in-setup')).toHaveAttribute('aria-label', 'Projects in setup: 4');
    await expect(kpi(page, 'projects-in-setup')).toContainText('Across 4 clients');
    await expect(kpi(page, 'reminders-due')).toHaveAttribute('aria-label', 'Reminders due: 2');
    await expect(kpi(page, 'ci-cd-live')).toHaveAttribute('aria-label', 'CI/CD live: 1/4');
    await expect(kpi(page, 'my-open-tickets')).toHaveAttribute('aria-label', 'My open tickets: 2');
    const rows = byTestId(page, 'home-list-reminders').locator('[data-testid^="home-row-"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Fjordline app');
    await expect(rows.nth(0)).toContainText('1d late');
    await expect(rows.nth(1)).toContainText('Today');
    await expect(rows.nth(3)).toContainText('In 6d');
    await expect(screen(page, 'home').getByText('Active projects')).toHaveCount(0);
    await rows.nth(0).click();
    await expectScreen(page, 'devops');
    await goTab(page, 'home');
    await kpi(page, 'my-open-tickets').click();
    await expectScreen(page, 'tickets');
  });

  test('M-44 client home: questions, bugs, progress and milestone', async ({ page }) => {
    await signInAs(page, 'client');
    await expect(byTestId(page, 'home-client')).toBeVisible();
    await expect(kpi(page, 'questions-for-you')).toHaveAttribute('aria-label', 'Questions for you: 2');
    await expect(kpi(page, 'open-bugs')).toHaveAttribute('aria-label', 'Open bugs: 2');
    await expect(kpi(page, 'daco-platform')).toHaveAttribute('aria-label', 'Daco platform: 42%');
    await expect(kpi(page, 'next-milestone')).toHaveAttribute('aria-label', 'Next milestone: 18 Oct');
    await expect(kpi(page, 'next-milestone')).toContainText('Sprint 2 demo');
    await expect(byTestId(page, 'home-list-questions')).toContainText('Needs your answer');
    await expect(byTestId(page, 'home-list-bugs')).toContainText('Received');
    await expect(byTestId(page, 'home-list-bugs')).not.toContainText('Critical');
    await expect(byTestId(page, 'home-week')).toHaveCount(0);
    await expect(byTestId(page, 'home-project-daco-platform')).toContainText('Progress');

    await kpi(page, 'questions-for-you').click();
    await expectScreen(page, 'questions');
    await goTab(page, 'home');
    await kpi(page, 'open-bugs').click();
    await expectScreen(page, 'bugs');
    await goTab(page, 'home');
    await kpi(page, 'daco-platform').click();
    await expectScreen(page, 'project');
    await back(page);
    await byTestId(page, 'home-row-q1').click();
    await expectScreen(page, 'question');
  });
});

test.describe('Tickets', () => {
  test('M-10 filter tickets: Open, Done and All recompute the groups', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'tickets');
    const s = screen(page, 'tickets');
    await expect(s.getByRole('heading', { name: 'My tickets' })).toBeVisible();
    await expect(s.getByRole('tab', { name: 'Open 6' })).toHaveAttribute('aria-selected', 'true');
    await expect(s.getByRole('tab', { name: 'Done 1' })).toBeVisible();
    await expect(s.getByRole('tab', { name: 'All 7' })).toBeVisible();
    const groups = () => s.locator('[data-testid^="ticket-group-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(await groups()).toEqual(['ticket-group-overdue', 'ticket-group-today', 'ticket-group-week']);
    await expect(byTestId(page, 'ticket-group-overdue').locator('[data-testid^="ticket-card-"]')).toHaveCount(2);

    await s.getByRole('tab', { name: 'Done 1' }).click();
    expect(await groups()).toEqual(['ticket-group-done']);
    await expect(byTestId(page, 'ticket-card-PMT-08')).toBeVisible();

    await s.getByRole('tab', { name: 'All 7' }).click();
    expect(await groups()).toEqual(['ticket-group-overdue', 'ticket-group-today', 'ticket-group-week', 'ticket-group-done']);
    await page.reload();
    await expectScreen(page, 'tickets');
    await expect(screen(page, 'tickets').getByRole('tab', { name: 'All 7' })).toHaveAttribute('aria-selected', 'true');
  });

  test('M-10 staffAll sees every ticket; pushed copy and empty state', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'tickets');
    await expect(screen(page, 'tickets').getByRole('heading', { name: 'Tickets' })).toBeVisible();
    await expect(screen(page, 'tickets').getByRole('tab', { name: 'All 12' })).toBeVisible();
    await page.goto('/stack/tickets');
    await expectScreen(page, 'stack-tickets');
    await expect(screen(page, 'stack-tickets').getByRole('tab', { name: 'Open 11' })).toBeVisible();
  });

  test('M-10 devops: only own tickets, Later bucket', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'tickets');
    await expect(screen(page, 'tickets').getByRole('tab', { name: 'Open 2' })).toBeVisible();
    await expect(byTestId(page, 'ticket-card-OPS-14')).toBeVisible();
    await expect(byTestId(page, 'ticket-group-later')).toContainText('OPS-15');
    await screen(page, 'tickets').getByRole('tab', { name: 'Done 0' }).click();
    await expect(screen(page, 'tickets').getByText('Nothing here.')).toBeVisible();
  });

  test('M-11 open a ticket from the Tickets tab: composer replaces the tab bar', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'tickets');
    await byTestId(page, 'ticket-card-PMT-11').click();
    await expectScreen(page, 'ticket');
    const s = screen(page, 'ticket');
    await expect(s.getByRole('heading', { name: 'PMT-11' })).toBeVisible();
    await expect(s.getByRole('heading', { name: 'Push notifications setup' })).toBeVisible();
    await expect(s).toContainText('Daco platform · Mobile app · Sprint 2');
    await expect(s).toContainText('Critical');
    await expect(s).toContainText('3d late');
    await expect(s).toContainText('3h over');
    await expect(s).toContainText('Locked once set');
    await expect(s).toContainText('1 of 3 subtasks done');
    await expect(byTestId(page, 'ticket-time-log')).toContainText('Duplicate push on Android');
    await expect(byTestId(page, 'ticket-chat')).toContainText('Comments');
    await expect(tabBar(page)).toHaveCount(0);
    await expect(byTestId(page, 'composer')).toBeVisible();
    await back(page);
    await expectScreen(page, 'tickets');
    await expect(tabBar(page)).toBeVisible();
  });

  test('M-11 client bug seen by staff: reporter chip and Client chat', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/ticket/9');
    await expectScreen(page, 'ticket');
    await expect(screen(page, 'ticket')).toContainText('Reported by Ingrid Solberg');
    await expect(byTestId(page, 'ticket-chat')).toContainText('Client chat');
    await expect(byTestId(page, 'ticket-desc-edit')).toHaveCount(0);
  });

  test('M-12 change ticket status: grid updates and toast shows', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/ticket/6');
    await expectScreen(page, 'ticket');
    await expect(byTestId(page, 'ticket-status-todo')).toHaveAttribute('aria-checked', 'true');
    await byTestId(page, 'ticket-status-prog').click();
    await expect(page.getByTestId('toast')).toHaveText('PMT-22 moved to In progress');
    await expect(byTestId(page, 'ticket-status-prog')).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'ticket-status-todo')).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await expect(byTestId(page, 'ticket-status-prog')).toHaveAttribute('aria-checked', 'true');
    await goTabFromTicket(page);
    await expect(byTestId(page, 'ticket-card-PMT-22')).toContainText('In progress');
  });

  test('M-13 comment on a ticket: text, photo-only and disabled send', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/ticket/6');
    await expectScreen(page, 'ticket');
    await expect(byTestId(page, 'ticket-chat')).toContainText('No comments yet.');
    const send = byTestId(page, 'composer-send');
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await byTestId(page, 'composer-input').fill('Starting on this today');
    await byTestId(page, 'composer-attach').click();
    await expect(byTestId(page, 'composer')).toContainText('photo-1.jpg');
    await send.click();
    const chat = byTestId(page, 'ticket-chat');
    await expect(chat).toContainText('Starting on this today');
    await expect(chat).toContainText('Chary · just now');
    await expect(chat).toContainText('photo-1.jpg');
    await expect(chat).not.toContainText('No comments yet.');
    await expect(byTestId(page, 'composer-input')).toHaveValue('');
    await expect(byTestId(page, 'composer')).not.toContainText('photo-1.jpg');

    await byTestId(page, 'composer-attach').click();
    await byTestId(page, 'composer-send').click();
    await expect(chat).toContainText('Sent a photo');

    await byTestId(page, 'composer-input').fill('Sent with Enter');
    await byTestId(page, 'composer-input').press('Enter');
    await expect(chat).toContainText('Sent with Enter');
  });

  test('M-14 entry: the + on Hours opens Log time for this ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.goto('/ticket/1');
    await expectScreen(page, 'ticket');
    await screen(page, 'ticket').getByRole('button', { name: 'Log time' }).click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    expect(page.url()).toContain('ticketId=1');
  });

  test('M-20 client edits the description of their bug', async ({ page }) => {
    await signInAs(page, 'client');
    await page.goto('/ticket/9');
    await expectScreen(page, 'ticket');
    const s = screen(page, 'ticket');
    await expect(byTestId(page, 'ticket-status-banner')).toContainText('Received');
    await expect(byTestId(page, 'ticket-status-banner')).toContainText('Updated by Viljetech');
    await expect(s).toContainText('by Ingrid Solberg');
    await expect(s).not.toContainText('Critical');
    await expect(byTestId(page, 'ticket-status-todo')).toHaveCount(0);
    await expect(byTestId(page, 'ticket-chat')).toContainText('Chat with Viljetech');
    await byTestId(page, 'ticket-desc-edit').click();
    await expect(byTestId(page, 'ticket-desc-edit')).toHaveText('Save');
    await byTestId(page, 'ticket-desc-input').fill('The login button is hidden on iPhone SE and 13 mini.');
    await byTestId(page, 'ticket-desc-edit').click();
    await expect(page.getByTestId('toast')).toHaveText('Description saved');
    await expect(byTestId(page, 'ticket-desc-text')).toHaveText('The login button is hidden on iPhone SE and 13 mini.');
    await page.reload();
    await expect(byTestId(page, 'ticket-desc-text')).toHaveText('The login button is hidden on iPhone SE and 13 mini.');
  });

  test('client cannot open other companies’ tickets (DECISIONS 9)', async ({ page }) => {
    await signInAs(page, 'client');
    await page.goto('/ticket/5');
    await expectScreen(page, 'ticket');
    await expect(screen(page, 'ticket')).toContainText('This ticket is not available.');
  });

  test('M-43 ticket board: project, epic, Board and List, open a card', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-board').click();
    await expectScreen(page, 'board');
    expect(await selectedTab(page)).toBe('More');
    const s = screen(page, 'board');
    await expect(s.getByRole('radio', { name: 'Daco platform' })).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'board-col-todo')).toContainText('To do');
    await expect(byTestId(page, 'board-col-todo').locator('[data-testid^="ticket-card-"]')).toHaveCount(2);
    await expect(byTestId(page, 'board-col-prog').locator('[data-testid^="ticket-card-"]')).toHaveCount(4);
    await expect(byTestId(page, 'board-col-review')).toContainText('No tickets');

    await s.getByRole('radio', { name: 'Web app' }).click();
    await expect(byTestId(page, 'board-col-prog').locator('[data-testid^="ticket-card-"]')).toHaveCount(1);
    await s.getByRole('radio', { name: 'Daco intranet' }).click();
    await expect(s.getByRole('radio', { name: 'All epics' })).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'board-col-review')).toContainText('DIN-5');

    await s.getByRole('radio', { name: 'Daco platform' }).click();
    await byTestId(page, 'board-view-list').click();
    await expect(byTestId(page, 'board-columns')).toHaveCount(0);
    await expect(byTestId(page, 'board-group-Mobile app · Sprint 2')).toBeVisible();
    await expect(byTestId(page, 'board-group-Web app · Sprint 1')).toBeVisible();
    await byTestId(page, 'ticket-card-PMT-34').click();
    await expectScreen(page, 'ticket');
    await back(page);
    await expectScreen(page, 'board');
    await expect(byTestId(page, 'board-view-list')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Notifications', () => {
  test('M-06 open a notification: marks it read and opens the ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'header-bell').click();
    await expectScreen(page, 'inbox');
    await expect(screen(page, 'inbox').locator('[data-testid^="notification-unread-"]')).toHaveCount(6);
    await byTestId(page, 'notification-s1').click();
    await expectScreen(page, 'ticket');
    await expect(screen(page, 'ticket').getByRole('heading', { name: 'PMT-11' })).toBeVisible();
    await back(page);
    await expectScreen(page, 'inbox');
    await expect(byTestId(page, 'notification-unread-s1')).toHaveCount(0);
    await expect(screen(page, 'inbox').locator('[data-testid^="notification-unread-"]')).toHaveCount(5);
    await back(page);
    await expect(byTestId(page, 'header-bell')).toHaveAttribute('aria-label', 'Notifications, 5 unread');
  });

  test('M-06 deploy notification opens DevOps with the project expanded; leave opens Leave', async ({ page }) => {
    await signInAs(page, 'pm');
    await page.goto('/inbox');
    await byTestId(page, 'notification-d1').click();
    await expectScreen(page, 'stack-devops');
    const saved = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const v = localStorage.getItem(localStorage.key(i)!) ?? '';
        if (v.includes('devopsOpen')) return v;
      }
      return '';
    });
    expect(saved).toContain('"devopsOpen":{"Daco platform":true}');
    await back(page);
    await byTestId(page, 'notification-s5').click();
    await expectScreen(page, 'leave');
  });

  test('M-06 freelancer feed has no leave item; client feed opens questions and projects', async ({ page }) => {
    await signInAs(page, 'free');
    await page.goto('/inbox');
    await expect(screen(page, 'inbox').locator('[data-testid^="notification-"]:not([data-testid*="unread"])')).toHaveCount(5);
    await expect(byTestId(page, 'notification-s5')).toHaveCount(0);

    await page.goto('/');
    await goTab(page, 'more');
    await byTestId(page, 'more-sign-out').click();
    await page.getByTestId('account-client').click();
    await expectScreen(page, 'home');
    await byTestId(page, 'header-bell').click();
    await expectScreen(page, 'inbox');
    await expect(screen(page, 'inbox').locator('[data-testid^="notification-unread-"]')).toHaveCount(4);
    await byTestId(page, 'notification-c1').click();
    await expectScreen(page, 'question');
    await back(page);
    await byTestId(page, 'notification-c4').click();
    await expectScreen(page, 'project');
    await back(page);
    await byTestId(page, 'notification-c3').click();
    await expectScreen(page, 'ticket');
    await expect(screen(page, 'ticket').getByRole('heading', { name: 'PMT-34' })).toBeVisible();
  });

  test('M-07 mark all read: dots go, the action hides, the badge clears', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'header-bell').click();
    await expectScreen(page, 'inbox');
    await byTestId(page, 'inbox-mark-all').click();
    await expect(screen(page, 'inbox').locator('[data-testid^="notification-unread-"]')).toHaveCount(0);
    await expect(byTestId(page, 'inbox-mark-all')).toHaveCount(0);
    await back(page);
    await expect(byTestId(page, 'header-bell')).toHaveAttribute('aria-label', 'Notifications');
    await page.reload();
    await expectScreen(page, 'home');
    await expect(byTestId(page, 'header-bell')).toHaveAttribute('aria-label', 'Notifications');
  });
});

test('every pressable on P1 screens has an accessible name', async ({ page }) => {
  await signInAs(page, 'admin');
  for (const url of ['/', '/tickets', '/ticket/1', '/board', '/inbox']) {
    await page.goto(url);
    await expect(page.locator('[data-testid^="screen-"]').filter({ visible: true }).first()).toBeVisible();
    const unnamed = await page.locator('[role=button]:not([aria-label]), [role=tab]:not([aria-label]), [role=radio]:not([aria-label])').count();
    expect(unnamed, url).toBe(0);
  }
});

/** From a ticket opened by URL, go to the Tickets tab (the tab bar is hidden on tickets). */
async function goTabFromTicket(page: Page) {
  await page.goto('/tickets');
  await expectScreen(page, 'tickets');
}
