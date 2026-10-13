import { mkdirSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { byTestId, expectScreen, goTab, headerTitle, openRoute, signInAs, signOut, toast, type AccountKey } from '../helpers/session';

/**
 * W4: DevOps (board, project, requests, settings) and the client portal (clients,
 * portal, questions, bugs, client team). Every W4 flow V-xx has a test whose title
 * starts with its id.
 */

const sheet = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function openDvp(page: Page, key: string, tab?: string) {
  await openRoute(page, `/dvp/${key}${tab ? `?tab=${tab}` : ''}`);
  await expectScreen(page, 'dvp');
}

/** Sign out from any screen (also with a URL sheet open, which hides the tab bar). */
async function leave(page: Page) {
  await openRoute(page, '/more');
  await expectScreen(page, 'more');
  await signOut(page);
}

async function switchTo(page: Page, key: AccountKey) {
  await leave(page);
  await signInAs(page, key);
}

// ── DevOps ──────────────────────────────────────────────────────────────────

test.describe('DevOps board', () => {
  test('V-90 devops tab: filters, search and grouping; project names, never "Client · Project"', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'devops');
    await expect(headerTitle(page)).toHaveText('DevOps board');
    await expect(byTestId(page, 'header-sub')).toHaveText('11 projects · 2 overdue');
    await expect(byTestId(page, 'dv-group-Planned')).toContainText('2 projects');
    const row = byTestId(page, 'dv-row-OPS-103');
    await expect(row).toContainText('Order portal');
    await expect(row).not.toContainText('Weland ·');
    await expect(row).toContainText('Client onboarding');
    // chips
    await byTestId(page, 'dv-chip-late').click();
    await expect(page.locator('[data-testid^="dv-row-"]').filter({ visible: true })).toHaveCount(2);
    await byTestId(page, 'dv-chip-client').click();
    await expect(page.locator('[data-testid^="dv-row-"]').filter({ visible: true })).toHaveCount(3);
    await byTestId(page, 'dv-chip-cicd').click();
    await expect(page.locator('[data-testid^="dv-row-"]').filter({ visible: true })).toHaveCount(4);
    await byTestId(page, 'dv-chip-all').click();
    // search by company and by key
    await byTestId(page, 'dv-search').fill('weland');
    await expect(page.locator('[data-testid^="dv-row-"]').filter({ visible: true })).toHaveCount(1);
    await byTestId(page, 'dv-search').fill('nothing like this');
    await expect(byTestId(page, 'dv-empty')).toHaveText('No projects match these filters.');
    await byTestId(page, 'dv-search').fill('');
    // group segments
    await byTestId(page, 'dv-group-owner').click();
    await expect(byTestId(page, 'dv-group-Ganesh')).toBeVisible();
    await byTestId(page, 'dv-group-dev').click();
    await expect(byTestId(page, 'dv-group-Production')).toContainText('2 projects');
    await expect(byTestId(page, 'dv-group-Not set')).toBeVisible();
    // row opens the project
    await byTestId(page, 'dv-row-OPS-106').click();
    await expectScreen(page, 'dvp');
    await expect(headerTitle(page)).toHaveText('Fast');
  });

  test('V-90 super and admin reach the pushed board from More; pm cannot', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-devops').click();
    await expectScreen(page, 'devops');
    await expect(byTestId(page, 'dv-new')).toBeVisible();
    await byTestId(page, 'dv-settings').click();
    await expectScreen(page, 'dvset');
    await switchTo(page, 'pm');
    await openRoute(page, '/dvp/OPS-101');
    await expect(toast(page)).toHaveText("You don't have access to this page");
  });

  test('V-91 add a project: picker lists projects without a DevOps record; header shows the project name', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'devops');
    await byTestId(page, 'dv-new').click();
    const s = sheet(page, 'sheet-dv-new');
    await expect(s).toBeVisible();
    const values = await s.getByTestId('dv-new-project').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
    expect(values).toContain('nordp');
    expect(values).toContain('i2');
    expect(values).not.toContain('dacop');
    expect(values).not.toContain('welop');
    expect(values).not.toContain('alncp'); // completed projects are not offered
    // required fields
    await byTestId(page, 'dv-new-save').click();
    await expect(s.getByTestId('field-error')).toHaveCount(2);
    await s.getByTestId('dv-new-project').selectOption('nordp');
    await s.getByTestId('dv-new-status').selectOption('Client onboarding');
    await s.getByTestId('dv-new-due').fill('2026-12-01');
    await byTestId(page, 'dv-new-save').click();
    await expect(toast(page)).toHaveText('OPS-112 created');
    await expectScreen(page, 'dvp');
    await expect(headerTitle(page)).toHaveText('Business portal');
    await expect(byTestId(page, 'header-sub')).toHaveText('OPS-112 · Nordlys Energi');
    await expect(byTestId(page, 'dvp-ladder')).toContainText('step 1 of 6');
    await byTestId(page, 'header-back').click();
    await expect(byTestId(page, 'dv-row-OPS-112')).toContainText('Business portal');
  });
});

test.describe('DevOps project', () => {
  test('V-92 change status to Client onboarding: the ladder starts', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-101');
    await expect(byTestId(page, 'dvp-no-followups')).toBeVisible();
    await byTestId(page, 'dvp-hero-status').click();
    await sheet(page, 'sheet-dv-status').getByTestId('dv-status-pick-Client onboarding').click();
    await expect(toast(page)).toHaveText('Status updated');
    await expect(byTestId(page, 'dvp-hero')).toContainText('Client onboarding');
    await expect(byTestId(page, 'dvp-ladder')).toContainText('Fixed schedule · step 1 of 6');
    // Deployment Completed sets the deployment
    await byTestId(page, 'dvp-hero-status').click();
    await sheet(page, 'sheet-dv-status').getByTestId('dv-status-pick-Deployment Completed').click();
    await expect(byTestId(page, 'dvp-hero')).toContainText('Deploy · Completed');
    await byTestId(page, 'dvp-tab-notes').click();
    await expect(byTestId(page, 'dvp-log-list')).toContainText('Status changed from Client onboarding to Deployment Completed');
  });

  test('V-93 edit the estimated deployment with a reason ("Moved" row) and a detail option', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-102');
    await byTestId(page, 'dvp-date-latestDue').click();
    const s = sheet(page, 'sheet-dv-field');
    await s.getByTestId('dv-field-date').fill('2026-12-20');
    await byTestId(page, 'dv-field-save').click();
    await expect(s.getByTestId('field-error')).toHaveText('Required');
    await s.getByTestId('dv-field-reason').fill('No response from client');
    await byTestId(page, 'dv-field-save').click();
    await expect(byTestId(page, 'dvp-date-latestDue')).toContainText('20 Dec 2026');
    await expect(byTestId(page, 'dvp-date-moved')).toContainText('No response from client');
    // a pick-list field from Details
    await byTestId(page, 'dvp-tab-details').click();
    await byTestId(page, 'dvp-field-prio').click();
    await sheet(page, 'sheet-dv-field').getByTestId('dv-field-pick-Low').click();
    await expect(byTestId(page, 'dvp-field-prio')).toContainText('Low');
  });

  test('V-94 edit the next step', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-104');
    await byTestId(page, 'dvp-next-edit').click();
    await sheet(page, 'sheet-dv-text').getByTestId('dv-text-input').fill('Plan the next infra change with the dev team.');
    await byTestId(page, 'dv-text-save').click();
    await expect(byTestId(page, 'dvp-next')).toHaveText('Plan the next infra change with the dev team.');
  });

  test('V-95 log a follow-up: the note is required by the rules, then the ladder advances', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-102');
    await expect(byTestId(page, 'dvp-ladder')).toContainText('step 2 of 6');
    await byTestId(page, 'dvp-log').click();
    const s = sheet(page, 'sheet-dv-log');
    await expect(s.getByTestId('dv-log-advance')).toContainText('Move to Reminder 2');
    await byTestId(page, 'dv-log-save').click();
    await expect(s.getByTestId('field-error')).toHaveCount(2);
    await s.getByTestId('dv-log-type-Call').click();
    await s.getByTestId('dv-log-note').fill('Called the client, details promised this week.');
    await s.getByTestId('dv-log-reminder').fill('2026-10-14');
    await byTestId(page, 'dv-log-save').click();
    await expect(toast(page)).toHaveText('Follow-up logged');
    await expect(byTestId(page, 'dvp-ladder')).toContainText('step 3 of 6');
    await expect(byTestId(page, 'dvp-ladder')).toContainText('Next reminder 14 Oct 2026, 07:00');
  });

  test('V-95 internal follow-up appends the next step', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-105');
    await byTestId(page, 'dvp-log').click();
    const s = sheet(page, 'sheet-dv-log');
    await expect(s.getByTestId('dv-log-next-name')).toHaveValue('Follow-up 2');
    await s.getByTestId('dv-log-note').fill('Dev team needs one more week.');
    await s.getByTestId('dv-log-reminder').fill('2026-10-21');
    await byTestId(page, 'dv-log-save').click();
    await expect(byTestId(page, 'dvp-ifu')).toContainText('Follow-up 2');
    await expect(byTestId(page, 'dvp-ifu')).toContainText('Dev team needs one more week.');
  });

  test('V-96 move the dev phase', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-107');
    await expect(byTestId(page, 'dvp-hero')).toContainText('Dev · Development');
    await byTestId(page, 'dvp-phases').getByRole('button', { name: 'Testing', exact: true }).click();
    await expect(byTestId(page, 'dvp-hero')).toContainText('Dev · Testing');
    await expect(byTestId(page, 'dvp-phases')).toContainText('Current phase');
  });

  test('V-97 toggle CI/CD', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-101', 'details');
    await expect(byTestId(page, 'dvp-hero')).toContainText('CI/CD off');
    await byTestId(page, 'dvp-cicd').click();
    await expect(byTestId(page, 'dvp-hero')).toContainText('CI/CD on');
    await expect(byTestId(page, 'dvp-cicd')).toContainText('On · each deploy reports to the timeline');
  });

  test('V-98 add a note (canDv only)', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-101', 'notes');
    await byTestId(page, 'dvp-notes-input').fill('Client contact confirmed.');
    await byTestId(page, 'dvp-notes-send').click();
    await expect(byTestId(page, 'dvp-notes')).toContainText('Client contact confirmed.');
    await expect(byTestId(page, 'dvp-notes-input')).toHaveValue('');
  });

  test('V-52 send a request from the DevOps project', async ({ page }) => {
    await signInAs(page, 'devops');
    await openDvp(page, 'OPS-101', 'requests');
    await byTestId(page, 'dvp-new-request').click();
    const s = sheet(page, 'sheet-devops-request');
    await expect(s).toContainText('Daco platform');
    await byTestId(page, 'req-send').click();
    await expect(s.getByTestId('field-error')).toHaveText('Required');
    await s.getByTestId('req-type-Access').click();
    await s.getByTestId('req-prio-High').click();
    await s.getByTestId('req-text').fill('VPN access for the staging server');
    await byTestId(page, 'req-send').click();
    await expect(toast(page)).toHaveText('Request sent to DevOps');
    await expect(byTestId(page, 'request-row-REQ-16')).toContainText('VPN access for the staging server');
    await expect(byTestId(page, 'dvp-tab-requests')).toContainText('1');
    await byTestId(page, 'dvp-tab-notes').click();
    await expect(byTestId(page, 'dvp-log-list')).toContainText('Request REQ-16 raised by Arjun');
  });

  test('V-52 send a request from the project DevOps tab (W2 project page)', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/project/inoffi?tab=devops');
    await expectScreen(page, 'project');
    await expect(byTestId(page, 'project-devops')).toBeVisible();
    await byTestId(page, 'project-send-request').click();
    await sheet(page, 'sheet-devops-request').getByTestId('req-text').fill('Second staging slot');
    await byTestId(page, 'req-send').click();
    await expect(toast(page)).toHaveText('Request sent to DevOps');
    await expect(byTestId(page, 'project-requests')).toContainText('Second staging slot');
  });

  test('V-99 mark a request done, reopen it and reply', async ({ page }) => {
    await signInAs(page, 'devops');
    await openRoute(page, '/request/3');
    await expectScreen(page, 'request');
    await expect(headerTitle(page)).toHaveText('REQ-9');
    await expect(byTestId(page, 'header-sub')).toHaveText('Fast');
    await byTestId(page, 'request-toggle').click();
    await expect(toast(page)).toHaveText('Marked as done');
    await expect(byTestId(page, 'request-hero')).toContainText('Done');
    await byTestId(page, 'request-toggle').click();
    await expect(byTestId(page, 'request-hero')).toContainText('Open');
    await byTestId(page, 'request-comments-input').fill('Moved to Tuesday.');
    await byTestId(page, 'request-comments-send').click();
    await expect(byTestId(page, 'request-comments')).toContainText('Moved to Tuesday.');
    await byTestId(page, 'request-project').click();
    await expectScreen(page, 'dvp');
    await byTestId(page, 'dvp-tab-notes').click();
    await expect(byTestId(page, 'dvp-log-list')).toContainText('Request REQ-9 reopened');
  });

  test('V-99 a pm sees requests read-only (no Mark as done, no project link)', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/request/1');
    await expectScreen(page, 'request');
    await expect(byTestId(page, 'request-toggle')).toHaveCount(0);
    await expect(byTestId(page, 'request-project').getByRole('button')).toHaveCount(0);
  });

  test('V-100 settings: add, rename and remove a status; add a phase; toggle a rule', async ({ page }) => {
    await signInAs(page, 'devops');
    await openRoute(page, '/dvset');
    await expectScreen(page, 'dvset');
    await byTestId(page, 'dvset-add-status').click();
    await sheet(page, 'sheet-dvset-item').getByTestId('dvset-item-name').fill('Security review');
    await byTestId(page, 'dvset-item-save').click();
    await expect(byTestId(page, 'dvset-status-7')).toContainText('Security review');
    // rename Client onboarding → every project on it follows
    await byTestId(page, 'dvset-status-1').click();
    await sheet(page, 'sheet-dvset-item').getByTestId('dvset-item-name').fill('Onboarding');
    await byTestId(page, 'dvset-item-save').click();
    await expect(byTestId(page, 'dvset-status-1')).toContainText('Onboarding');
    await expect(byTestId(page, 'dvset-status-1')).toContainText('3 projects');
    // remove it → the projects move to the first status
    await byTestId(page, 'dvset-status-1').click();
    await byTestId(page, 'dvset-item-remove').click();
    await expect(byTestId(page, 'dvset-status-0')).toContainText('5 projects');
    // phases
    await byTestId(page, 'dvset-seg-ph').click();
    await byTestId(page, 'dvset-add-phase').click();
    await sheet(page, 'sheet-dvset-item').getByTestId('dvset-item-name').fill('Hypercare');
    await sheet(page, 'sheet-dvset-item').getByTestId('dvset-item-days').fill('7');
    await byTestId(page, 'dvset-item-save').click();
    await expect(byTestId(page, 'dvset-phases')).toContainText('Hypercare');
    await expect(byTestId(page, 'dvset-phases')).toContainText('7 days');
    // follow-ups are read-only
    await byTestId(page, 'dvset-seg-seq').click();
    await expect(byTestId(page, 'dvset-ladder')).toContainText('Escalate from');
    // rules: switch off "Require a note", then a follow-up needs no note
    await byTestId(page, 'dvset-seg-rules').click();
    const rule = byTestId(page, 'dvset-rule-requireNote');
    await expect(rule).toHaveAttribute('aria-checked', 'true');
    await rule.click();
    await expect(rule).toHaveAttribute('aria-checked', 'false');
    await openDvp(page, 'OPS-109');
    await byTestId(page, 'dvp-log').click();
    await sheet(page, 'sheet-dv-log').getByTestId('dv-log-reminder').fill('2026-10-15');
    await byTestId(page, 'dv-log-save').click();
    await expect(toast(page)).toHaveText('Follow-up logged');
  });
});

// ── Client portal ───────────────────────────────────────────────────────────

test.describe('Client portal', () => {
  test('V-53 staff Clients → portal → raise a question → the client sees it', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-clients').click();
    await expectScreen(page, 'clients');
    await expect(byTestId(page, 'client-row-daco')).toContainText('2 waiting');
    await expect(byTestId(page, 'client-row-daco')).toContainText('2 open bugs');
    await byTestId(page, 'client-row-daco').click();
    await expectScreen(page, 'portal');
    await expect(headerTitle(page)).toHaveText('Daco');
    await expect(byTestId(page, 'portal-hero')).toContainText('What Daco sees when they sign in');
    await expect(byTestId(page, 'portal-team-add')).toHaveCount(0);
    await byTestId(page, 'portal-raise').click();
    const s = sheet(page, 'sheet-new-question');
    await expect(s).toContainText('Daco · Daco platform');
    await byTestId(page, 'newq-save').click();
    await expect(s.getByTestId('field-error')).toHaveCount(2);
    await s.getByTestId('newq-title').fill('Push notification wording');
    await s.getByTestId('newq-text').fill('Which text should the reminder push show?');
    await s.getByTestId('newq-task').selectOption('PMT-11');
    await byTestId(page, 'newq-save').click();
    await expect(toast(page)).toHaveText('Question sent to Daco');
    await expect(byTestId(page, 'portal-questions')).toContainText('Push notification wording');
    await switchTo(page, 'cadmin');
    await expect(page.getByTestId('tab-questions')).toContainText('3');
    await goTab(page, 'questions');
    await expect(byTestId(page, 'questions')).toContainText('Push notification wording');
  });

  test('V-53 ask a follow-up on an answered question (title prefilled)', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/question/2');
    await expectScreen(page, 'question');
    await expect(byTestId(page, 'question-answer')).toContainText('Use the new version');
    await byTestId(page, 'question-follow-up').click();
    await expect(sheet(page, 'sheet-new-question').getByTestId('newq-title')).toHaveValue('Re: Logo files for the app icon');
  });

  test('V-60 answer a question: the badge drops and it moves to Answered', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await expect(page.getByTestId('tab-questions')).toContainText('2');
    await goTab(page, 'questions');
    await byTestId(page, 'question-row-4').click();
    await expectScreen(page, 'question');
    await expect(byTestId(page, 'question-hero')).toContainText('Linked to PMT-10');
    await byTestId(page, 'question-send').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Type your answer first');
    await byTestId(page, 'question-answer-input').fill('Use the BankID test environment.');
    await byTestId(page, 'question-send').click();
    await expect(toast(page)).toHaveText('Answer sent to the team');
    await expect(byTestId(page, 'question-hero')).toContainText('Answered');
    await expect(byTestId(page, 'question-answer')).toContainText('Use the BankID test environment.');
    await expect(page.getByTestId('tab-questions')).toContainText('1');
    await byTestId(page, 'header-back').click();
    await byTestId(page, 'questions-seg-done').click();
    await expect(byTestId(page, 'question-row-4')).toBeVisible();
  });

  test('V-61 report a bug from the Bugs tab', async ({ page }) => {
    await signInAs(page, 'cuser');
    await goTab(page, 'bugs');
    await byTestId(page, 'bugs-report').click();
    const s = sheet(page, 'sheet-report-bug');
    await expect(s).toContainText('The team gets notified straight away');
    await byTestId(page, 'bug-send').click();
    await expect(s.getByTestId('field-error')).toHaveCount(2);
    await s.getByTestId('bug-area').selectOption('web');
    await s.getByTestId('bug-title').fill('Export button does nothing');
    await s.getByTestId('bug-desc').fill('Tap Export on the reports page, nothing happens.');
    await byTestId(page, 'bug-send').click();
    await expect(toast(page)).toHaveText('Bug reported. Thank you.');
    await byTestId(page, 'bugs-seg-mine').click();
    await expect(byTestId(page, 'bugs')).toContainText('Export button does nothing');
    await expect(byTestId(page, 'bugs')).toContainText('Reported by you');
  });

  test('V-62 reply on a bug', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await goTab(page, 'bugs');
    await byTestId(page, 'bug-row-cbm1').click();
    await expectScreen(page, 'bug');
    await expect(byTestId(page, 'bug-chat')).toContainText('No replies yet.');
    await byTestId(page, 'bug-chat-input').fill('It also happens on Android.');
    await byTestId(page, 'bug-chat-send').click();
    await expect(byTestId(page, 'bug-chat')).toContainText('It also happens on Android.');
    await expect(byTestId(page, 'bug-hero-status')).toHaveCount(0);
  });

  test('V-63 staff changes the bug status; the client label updates', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/bug/cbm2');
    await expectScreen(page, 'bug');
    await expect(byTestId(page, 'bug-hero')).toContainText('Received');
    await byTestId(page, 'bug-hero-status').click();
    await expect(sheet(page, 'sheet-bug-status')).toContainText('Client sees: Testing');
    await sheet(page, 'sheet-bug-status').getByTestId('bug-status-pick-review').click();
    await expect(byTestId(page, 'bug-hero')).toContainText('Testing');
    await expect(byTestId(page, 'bug-progress')).toContainText('Current step');
    await switchTo(page, 'cuser');
    await goTab(page, 'bugs');
    await expect(byTestId(page, 'bug-row-cbm2')).toContainText('Testing');
  });

  test('V-64 cadmin manages the team: add, edit, remove', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-users').click();
    await expectScreen(page, 'users');
    await expect(headerTitle(page)).toHaveText('Your team');
    await expect(byTestId(page, 'client-team')).toContainText('Ingrid Solberg (you)');
    await byTestId(page, 'team-add-button').click();
    const s = sheet(page, 'sheet-client-member');
    await s.getByTestId('member-name').fill('Maja Holm');
    await s.getByTestId('member-title').fill('Site manager');
    await s.getByTestId('member-email').fill('maja@daco');
    await byTestId(page, 'member-save').click();
    await expect(toast(page)).toHaveText('Check the email address');
    await s.getByTestId('member-email').fill('maja@daco.se');
    await byTestId(page, 'member-save').click();
    await expect(toast(page)).toHaveText('Invite sent');
    await expect(byTestId(page, 'client-team')).toContainText('Maja Holm');
    await expect(byTestId(page, 'client-team')).toContainText('Site manager · maja@daco.se');
    // edit
    await byTestId(page, 'client-team').getByRole('button', { name: 'Maja Holm' }).click();
    await expect(sheet(page, 'sheet-client-member').getByTestId('member-name')).toHaveValue('Maja Holm');
    await sheet(page, 'sheet-client-member').getByTestId('member-title').fill('Operations lead');
    await byTestId(page, 'member-save').click();
    await expect(toast(page)).toHaveText('Saved');
    await expect(byTestId(page, 'client-team')).toContainText('Operations lead');
    // remove
    await byTestId(page, 'client-team').getByRole('button', { name: 'Maja Holm' }).click();
    await byTestId(page, 'member-remove').click();
    // asks first: Cancel keeps the member
    await expect(byTestId(page, 'member-remove-confirm')).toContainText('Remove Maja Holm?');
    await byTestId(page, 'member-remove-confirm-cancel').click();
    await expect(sheet(page, 'sheet-client-member').getByTestId('member-name')).toHaveValue('Maja Holm');
    await byTestId(page, 'member-remove').click();
    await byTestId(page, 'member-remove-confirm-ok').click();
    await expect(toast(page)).toHaveText('Member removed');
    await expect(byTestId(page, 'client-team')).not.toContainText('Maja Holm');
    await expect(byTestId(page, 'client-team')).toContainText('Anna Lindqvist');
  });

  test('V-64 cadmin adds from the portal; cuser has no team section', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await goTab(page, 'projects');
    await expect(headerTitle(page)).toHaveText('Projects');
    await expect(byTestId(page, 'portal-projects')).toContainText('Daco platform');
    await byTestId(page, 'portal-team-add').click();
    await expect(sheet(page, 'sheet-client-member')).toContainText('Add someone from your team');
    await switchTo(page, 'cuser');
    await goTab(page, 'projects');
    await expect(byTestId(page, 'portal-projects')).toContainText('Daco platform');
    await expect(byTestId(page, 'portal-team')).toHaveCount(0);
    await expect(byTestId(page, 'portal-team-add')).toHaveCount(0);
  });

  test('V-65 filter questions and bugs with the segments', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await goTab(page, 'questions');
    await expect(byTestId(page, 'questions-seg-wait')).toContainText('2');
    await expect(page.locator('[data-testid^="question-row-"]').filter({ visible: true })).toHaveCount(2);
    await byTestId(page, 'questions-seg-done').click();
    await expect(page.locator('[data-testid^="question-row-"]').filter({ visible: true })).toHaveCount(1);
    await goTab(page, 'bugs');
    await expect(page.locator('[data-testid^="bug-row-"]').filter({ visible: true })).toHaveCount(3);
    await byTestId(page, 'bugs-seg-mine').click();
    await expect(page.locator('[data-testid^="bug-row-"]').filter({ visible: true })).toHaveCount(1);
    await byTestId(page, 'bugs-seg-done').click();
    await expect(byTestId(page, 'bug-row-cbm3')).toContainText('Fixed');
  });
});

// ── Screenshots (390x844) for comparison with mobile-spec-v5/screenshots ─────

const SHOTS: [AccountKey, string, string, string?][] = [
  ['super', '/stack/devops', '090-devops-board'],
  ['super', '/dvp/OPS-103', '094-dvp-status-client-ladder'],
  ['super', '/dvp/OPS-106', '095-dvp-status-internal'],
  ['super', '/dvp/OPS-101', '096-dvp-status-none'],
  ['super', '/dvp/OPS-106?tab=details', '097-dvp-details'],
  ['super', '/dvp/OPS-106?tab=deploys', '098-dvp-deploys'],
  ['super', '/dvp/OPS-106?tab=requests', '100-dvp-requests'],
  ['super', '/dvp/OPS-102?tab=notes', '101-dvp-notes'],
  ['super', '/request/3', '102-devops-request'],
  ['super', '/dvset', '103-dvset-statuses'],
  ['super', '/clients', '080-clients'],
  ['super', '/portal/daco', '081-portal-staff-view'],
  ['super', '/question/1', '082-question-staff-waiting'],
  ['super', '/question/2', '083-question-staff-answered'],
  ['super', '/bug/cbm1', '084-bug-staff'],
  ['super', '/sheet/devops-request?key=OPS-106', '229-sheet-devops-request'],
  ['super', '/sheet/new-question?pid=dacop', '230-sheet-question-to-client'],
  ['devops', '/devops', '341-devops-board-tab'],
  ['cadmin', '/projects', '351-cadmin-portal'],
  ['cadmin', '/questions', '360-cadmin-questions'],
  ['cadmin', '/question/4', '362-cadmin-question-answer'],
  ['cadmin', '/bugs', '364-cadmin-bugs'],
  ['cadmin', '/bug/cbm1', '365-cadmin-bug'],
  ['cadmin', '/users', '367-cadmin-your-team'],
  ['cadmin', '/sheet/report-bug?pid=dacop', '369-sheet-report-bug'],
  ['cadmin', '/sheet/client-member', '372-sheet-client-member-add'],
  ['cadmin', '/sheet/client-member?email=anna%40daco.se', '373-sheet-client-member-edit'],
  ['cuser', '/projects', '382-cuser-portal'],
];

test('W4 screenshots at 390x844', async ({ page }) => {
  test.setTimeout(180_000);
  const dir = process.env.W4_SHOTS ?? '/tmp/claude-0/shots-mob5-w4';
  mkdirSync(dir, { recursive: true });
  let who: AccountKey | null = null;
  for (const [acc, path, name] of SHOTS) {
    if (who !== acc) {
      if (who) await leave(page);
      await signInAs(page, acc);
      who = acc;
    }
    await openRoute(page, path);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
  // inline sheets
  await leave(page);
  await signInAs(page, 'super');
  await openDvp(page, 'OPS-103');
  await byTestId(page, 'dvp-hero-status').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/243-sheet-dv-status.png` });
  await sheet(page, 'sheet-dv-status').getByTestId('sheet-dv-status-close').click();
  await byTestId(page, 'dvp-log').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/247-sheet-dv-log-client.png` });
  await openRoute(page, '/stack/devops');
  await byTestId(page, 'dv-new').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/249-sheet-dv-new-project.png` });
});
