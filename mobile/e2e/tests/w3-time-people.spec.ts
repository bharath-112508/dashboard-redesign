import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import {
  ACCOUNTS,
  byTestId,
  expectScreen,
  goTab,
  headerTitle,
  openRoute,
  openSignIn,
  selectedTab,
  signInAs,
  signInWithEmail,
  signOut,
  TAB_LABELS,
  tabLabels,
  toast,
} from '../helpers/session';

/**
 * W3 (mobile-spec-v5): sign in, More, Profile, Timesheet + SH-LOG, My leave, Employee
 * and Company timesheets, Users (+ Leave, Permissions), User, Companies, Company and
 * their sheets. Every W3 flow V-xx has a test whose title starts with its ID.
 */

const sheet = (page: Page, name: string) => page.getByTestId(`sheet-${name}`);

/** Open SH-LOG from the Timesheet's Log view. */
async function openLogFromTimesheet(page: Page) {
  await goTab(page, 'time');
  await byTestId(page, 'time-log').click();
  await expect(sheet(page, 'log-time')).toBeVisible();
}

async function pickProject(page: Page, value: string) {
  await page.getByTestId('log-proj').click();
  await page.getByTestId(`log-proj-${value}`).click();
}

async function fillTime(page: Page, h: string, m: string) {
  await page.getByTestId('log-time-h').fill(h);
  await page.getByTestId('log-time-m').fill(m);
}

// ── Account ────────────────────────────────────────────────────────────────

test.describe('account', () => {
  test('V-01 sign in with email and password; errors', async ({ page }) => {
    await openSignIn(page);
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Enter your email.');
    await page.getByTestId('sign-in-email').fill('nobody@example.com');
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText("We don't recognise that email.");
    await page.getByTestId('sign-in-email').fill('bhavana@viljetech.com');
    await page.getByTestId('sign-in-password').fill('nope');
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText('That password is not right.');
    await page.getByTestId('sign-in-password').fill('demo');
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.pm);
  });

  test('V-02 a sample user row fills email and password and is highlighted', async ({ page }) => {
    await openSignIn(page);
    await page.getByTestId('account-freelancer').click();
    await expect(page.getByTestId('sign-in-email')).toHaveValue(ACCOUNTS.freelancer.email);
    await expect(page.getByTestId('sign-in-password')).toHaveValue('demo');
    await expect(page.getByTestId('account-freelancer')).toHaveCSS('background-color', 'rgb(242, 246, 254)');
    await expect(page.getByTestId('account-dev')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
  });

  test('V-03 sign out from More and from Profile', async ({ page }) => {
    await signInAs(page, 'dev');
    await signOut(page);
    await page.getByTestId('account-dev').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await goTab(page, 'more');
    await byTestId(page, 'more-profile-settings').click();
    await expectScreen(page, 'me');
    await byTestId(page, 'profile-sign-out').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveValue('');
  });

  test('More: profile row, pages and account section', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'more');
    await expect(byTestId(page, 'more-profile')).toContainText('Bhavana P');
    await expect(byTestId(page, 'more-profile')).toContainText('Project manager · Viljetech');
    await byTestId(page, 'more-page-leave').click();
    await expectScreen(page, 'leave');
    expect(await selectedTab(page)).toBe('More');
  });

  test('V-04 save profile: validation, toast, directory updated, new password', async ({ page }) => {
    await signInAs(page, 'admin');
    await goTab(page, 'more');
    await byTestId(page, 'more-profile').click();
    await expectScreen(page, 'me');
    await expect(headerTitle(page)).toHaveText('Profile settings');
    await expect(byTestId(page, 'header-sub')).toHaveText('Admin · Viljetech');
    await expect(byTestId(page, 'profile-email')).toHaveValue('vivek@viljetech.com');
    await expect(byTestId(page, 'notif-weekly')).toBeVisible();
    await byTestId(page, 'profile-name').fill('');
    await byTestId(page, 'profile-save').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Add your name');
    await byTestId(page, 'profile-name').fill('Vivek R');
    await byTestId(page, 'profile-pw1').fill('short');
    await byTestId(page, 'profile-save').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Password needs at least 8 characters');
    await byTestId(page, 'profile-pw1').fill('longenough1');
    await byTestId(page, 'profile-pw2').fill('different1');
    await byTestId(page, 'profile-save').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Passwords do not match');
    await byTestId(page, 'profile-pw2').fill('longenough1');
    await byTestId(page, 'notif-due').click();
    await expect(byTestId(page, 'notif-due')).toHaveAttribute('aria-checked', 'false');
    await byTestId(page, 'profile-save').click();
    await expect(toast(page)).toHaveText('Profile saved');
    await expect(byTestId(page, 'profile-pw1')).toHaveValue('');
    await expect(byTestId(page, 'profile-hero')).toContainText('Vivek R');
    // the directory person is written too (A-17)
    await openRoute(page, '/users');
    await expect(byTestId(page, 'user-row-2')).toContainText('Vivek R');
    // the new password signs in
    await signOut(page);
    await signInWithEmail(page, 'vivek@viljetech.com', 'longenough1');
    await expectScreen(page, 'home');
  });

  test('V-04 clients see no staff-only notification rows', async ({ page }) => {
    await signInAs(page, 'cuser');
    await byTestId(page, 'header-profile').click();
    await expectScreen(page, 'me');
    await expect(byTestId(page, 'notif-tickets')).toBeVisible();
    await expect(byTestId(page, 'notif-due')).toHaveCount(0);
    await expect(byTestId(page, 'notif-weekly')).toHaveCount(0);
    await expect(byTestId(page, 'header-sub')).toHaveText('Client user · Daco');
  });

  test('V-05 switching tab resets the stack', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-companies').click();
    await byTestId(page, 'company-row-daco').click();
    await expectScreen(page, 'company');
    await goTab(page, 'time');
    expect(await selectedTab(page)).toBe('Time');
    await goTab(page, 'more');
    await expect(byTestId(page, 'header-back')).toHaveCount(0);
  });
});

// ── Time ───────────────────────────────────────────────────────────────────

test.describe('time', () => {
  test('V-10 log time from the dashboard against a ticket', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'dash-log-time').click();
    await expect(sheet(page, 'log-time')).toBeVisible();
    await expect(sheet(page, 'log-time')).toContainText('Log your time');
    await expect(page.getByTestId('log-ticket')).toContainText('Choose a project first');
    await page.getByTestId('log-proj').click();
    await expect(page.getByTestId('log-proj-c:dacop')).toBeVisible();
    await expect(page.getByTestId('log-proj-x:admin')).toContainText('Admin & meetings');
    await page.getByTestId('log-proj-c:dacop').click();
    await expect(page.getByTestId('log-proj')).toContainText('Daco platform');
    await page.getByTestId('log-ticket').click();
    await expect(page.getByTestId('log-tk-PMT-11.1')).toContainText('↳');
    await page.getByTestId('log-tk-PMT-10').click();
    await expect(page.getByTestId('log-ticket')).toContainText('PMT-10');
    await fillTime(page, '1', '30');
    await page.getByTestId('log-note').fill('Pairing');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('1h 30m logged');
    await expect(sheet(page, 'log-time')).toHaveCount(0);
    await expectScreen(page, 'home');
    await goTab(page, 'time');
    await expect(byTestId(page, 'time-entries')).toContainText('Login with BankID');
    await expect(byTestId(page, 'time-entries')).toContainText('Pairing');
    await expect(byTestId(page, 'kpi-day')).toContainText('1h 30m');
  });

  test('V-10 log time from the timesheet (selected day), text mode and admin', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'time');
    await byTestId(page, 'day-2026-10-07').click();
    await expect(byTestId(page, 'kpi-day')).toContainText('Wed 7 Oct');
    await byTestId(page, 'time-log').click();
    await expect(page.getByTestId('log-date')).toHaveValue('2026-10-07');
    await pickProject(page, 'x:admin');
    await expect(page.getByTestId('log-mode-ticket')).toHaveCount(0);
    await expect(page.getByTestId('log-bill')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('log-text').fill('Steering group');
    await fillTime(page, '0', '45');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('45m logged');
    await expect(byTestId(page, 'time-entries')).toContainText('Steering group');
    await expect(byTestId(page, 'time-entries')).toContainText('Non-billable');
  });

  test('V-10 log time against a subtask (ticket Time preset with the subtask key)', async ({ page }) => {
    await signInAs(page, 'dev');
    await openRoute(page, '/sheet/log-time?proj=c%3Adacop&key=PMT-11.s2');
    await expect(sheet(page, 'log-time')).toBeVisible();
    await expect(page.getByTestId('log-proj')).toContainText('Daco platform');
    await expect(page.getByTestId('log-ticket')).toContainText('PMT-11.2');
    await fillTime(page, '2', '0');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('2h logged');
  });

  test('V-10 a positional subtask key and a text preset (Support upkeep) are accepted', async ({ page }) => {
    await signInAs(page, 'dev');
    await openRoute(page, '/sheet/log-time?proj=c%3Adacop&key=PMT-11.1');
    await expect(page.getByTestId('log-ticket')).toContainText('PMT-11.1');
    await openRoute(page, '/sheet/log-time?proj=c%3Adacop&text=Backup%20restore%20test');
    await expect(page.getByTestId('log-mode-text')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('log-text')).toHaveValue('Backup restore test');
  });

  test('V-11 log time validation, in order', async ({ page }) => {
    await signInAs(page, 'super');
    await openLogFromTimesheet(page);
    await page.getByTestId('log-save').click();
    await expect(page.getByTestId('log-error')).toHaveText('Pick a project first');
    await expect(page.getByTestId('log-proj')).toHaveCSS('background-color', 'rgb(251, 243, 239)');
    await expect(sheet(page, 'log-time').getByTestId('field-error')).toHaveText('Add the time spent');
    await pickProject(page, 'c:dacop');
    await page.getByTestId('log-save').click();
    await expect(page.getByTestId('log-error')).toHaveText('Pick a ticket, or switch to text');
    await page.getByTestId('log-mode-text').click();
    await page.getByTestId('log-save').click();
    await expect(page.getByTestId('log-error')).toHaveText('Describe what you worked on');
    await page.getByTestId('log-text').fill('Code review');
    await page.getByTestId('log-save').click();
    await expect(page.getByTestId('log-error')).toHaveText('Add the time spent');
    await fillTime(page, '0', '20');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('20m logged');
  });

  test('V-12 edit and delete an entry', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'time');
    await byTestId(page, 'day-2026-10-05').click();
    await byTestId(page, 'entry-1').click();
    await expect(sheet(page, 'log-time')).toContainText('Edit time');
    await expect(page.getByTestId('log-time-h')).toHaveValue('3');
    await expect(page.getByTestId('log-ticket')).toContainText('PMT-10');
    await page.getByTestId('log-time-h').fill('4');
    await page.getByTestId('log-save').click();
    await expect(toast(page)).toHaveText('4h logged');
    await expect(byTestId(page, 'entry-1')).toContainText('4h');
    await byTestId(page, 'entry-2').click();
    await page.getByTestId('log-delete').click();
    await expect(toast(page)).toHaveText('Entry deleted');
    await expect(byTestId(page, 'entry-2')).toHaveCount(0);
  });

  test('V-13 browse: day strip, week navigation, history filters', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'time');
    await expect(byTestId(page, 'kpi-day')).toContainText('Sat 10 Oct · Today');
    await expect(byTestId(page, 'kpi-day')).toContainText('Weekend');
    await expect(byTestId(page, 'day-2026-10-05')).toContainText('4h');
    await byTestId(page, 'day-2026-10-08').click();
    await expect(byTestId(page, 'kpi-day')).toContainText('3h idle');
    await expect(byTestId(page, 'entry-7')).toBeVisible();
    // week
    await byTestId(page, 'time-seg-week').click();
    await expect(byTestId(page, 'week-now')).toContainText('5 Oct – 11 Oct');
    await expect(byTestId(page, 'week-next')).toHaveAttribute('aria-disabled', 'true');
    await expect(byTestId(page, 'kpi-idle')).toContainText('Idle');
    await expect(byTestId(page, 'week-heat')).toContainText('PMT-10 · Login with BankID');
    await byTestId(page, 'week-prev').click();
    await expect(byTestId(page, 'week-now')).toContainText('28 Sep – 4 Oct');
    await byTestId(page, 'week-now').click();
    await expect(byTestId(page, 'week-now')).toContainText('5 Oct – 11 Oct');
    // history
    await byTestId(page, 'time-seg-hist').click();
    await expect(byTestId(page, 'hist-kpis')).toContainText('entries');
    await byTestId(page, 'hist-per-week').click();
    await expect(byTestId(page, 'hist-kpis')).toContainText('25h 45m');
    await expect(byTestId(page, 'hist-kpis')).toContainText('9 entries');
    await byTestId(page, 'hist-project').selectOption('x:admin');
    await expect(byTestId(page, 'hist-kpis')).toContainText('2h 30m');
    await byTestId(page, 'hist-group-proj').click();
    await expect(byTestId(page, 'hist-group-block')).toHaveCount(1);
    await expect(byTestId(page, 'hist-group-block')).toContainText('Admin & meetings');
    await byTestId(page, 'hist-group-task').click();
    await expect(byTestId(page, 'hist-group-block')).toHaveCount(2);
    await byTestId(page, 'hist-project').selectOption('c:fjp');
    await expect(byTestId(page, 'hist-empty')).toHaveText('No entries match these filters.');
  });

  test('V-14 download my timesheet CSV', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'time');
    await byTestId(page, 'time-seg-hist').click();
    await byTestId(page, 'hist-per-week').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'hist-csv').click()]);
    expect(dl.suggestedFilename()).toBe('timesheet-bhavana-p.csv');
    const text = readFileSync((await dl.path())!, 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Date,Project,Ticket,Task,Billable,Minutes,Note');
    expect(lines).toHaveLength(10);
    expect(text).toContain('2026-10-05,Daco · Daco platform,PMT-10,Login with BankID,Yes,180,Token refresh flow');
  });

  test('V-14 download employee timesheets CSV', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/emp');
    await expectScreen(page, 'emp');
    const [dl] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'team-csv').click()]);
    expect(dl.suggestedFilename()).toBe('employee-timesheets.csv');
    const text = readFileSync((await dl.path())!, 'utf8');
    expect(text.split('\n')[0]).toBe('Date,Employee,Project,Ticket,Task,Billable,Minutes');
    expect(text).toContain(',Vivek,');
  });

  test('V-15 employee timesheets: chips, selects, tap-to-filter, clear', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-emp').click();
    await expectScreen(page, 'emp');
    await expect(byTestId(page, 'header-sub')).toHaveText('All projects and employees');
    const people = byTestId(page, 'team-people');
    await expect(people).toContainText('6');
    await byTestId(page, 'team-by-employee').getByRole('button', { name: 'Chary' }).click();
    await expect(byTestId(page, 'team-employee')).toHaveValue('Chary');
    await expect(people).toContainText('1');
    await expect(byTestId(page, 'team-entries')).not.toContainText('Vivek ·');
    await byTestId(page, 'team-by-project').getByRole('button').first().click();
    await expect(byTestId(page, 'team-project')).not.toHaveValue('all');
    await byTestId(page, 'team-clear').click();
    await expect(byTestId(page, 'team-employee')).toHaveValue('all');
    await expect(byTestId(page, 'team-project')).toHaveValue('all');
    await expect(byTestId(page, 'team-clear')).toHaveCount(0);
    await byTestId(page, 'team-per-all').click();
    await byTestId(page, 'team-project').selectOption('c:nordp');
    await expect(byTestId(page, 'team-entries')).toContainText('Nordlys Energi · Business portal');
  });

  test('V-15 company timesheets from the company page, filtered by project', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/company/daco');
    await expectScreen(page, 'company');
    await byTestId(page, 'company-time').getByRole('button').first().click();
    await expectScreen(page, 'company-time');
    await expect(headerTitle(page)).toHaveText('Timesheets · Daco');
    await expect(byTestId(page, 'header-sub')).toHaveText('Daco platform');
    await expect(byTestId(page, 'team-project')).toHaveValue('c:dacop');
    await expect(byTestId(page, 'team-by-project')).toHaveCount(0);
    await byTestId(page, 'team-clear').click();
    await expect(byTestId(page, 'header-sub')).toHaveText('All projects');
    const [dl] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'team-csv').click()]);
    expect(dl.suggestedFilename()).toBe('timesheets-daco.csv');
  });

  test('V-15 a developer sees only their own hours in company timesheets', async ({ page }) => {
    await signInAs(page, 'dev');
    await openRoute(page, '/company/daco');
    await byTestId(page, 'company-time-all').click();
    await expectScreen(page, 'company-time');
    await expect(byTestId(page, 'header-sub')).toHaveText('All projects · your hours');
    await expect(byTestId(page, 'team-employee')).toHaveCount(0);
    await expect(byTestId(page, 'team-people')).toContainText('1');
  });

  test('freelancer week has no idle time and no targets', async ({ page }) => {
    await signInAs(page, 'freelancer');
    await goTab(page, 'time');
    await expect(byTestId(page, 'header-sub')).toHaveText('Sofia · Freelancer');
    await expect(byTestId(page, 'kpi-week')).not.toContainText('/ 40h');
    await byTestId(page, 'day-2026-10-08').click();
    await expect(byTestId(page, 'kpi-day')).toContainText('Freelancer · no idle time');
    await byTestId(page, 'time-seg-week').click();
    await expect(byTestId(page, 'kpi-idle')).toContainText('No idle');
    await expect(byTestId(page, 'week-bars')).not.toContainText('Idle');
  });

  test('roles without Timesheet access get no log sheet', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await openRoute(page, '/sheet/log-time');
    await expectScreen(page, 'home');
  });
});

// ── People, leave and permissions ─────────────────────────────────────────

test.describe('people', () => {
  test('V-70 find users: search, org segment, role chips', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-users').click();
    await expectScreen(page, 'users');
    await expect(byTestId(page, 'users-seg-leave')).toContainText('4');
    await expect(byTestId(page, 'users-list')).toContainText('Rahul');
    await expect(page.getByText('6 users')).toBeVisible();
    await byTestId(page, 'users-org-client').click();
    await expect(page.getByText('4 users')).toBeVisible();
    await expect(byTestId(page, 'user-row-10')).toContainText('Deactivated');
    await byTestId(page, 'users-org-all').click();
    await byTestId(page, 'users-role-dev').click();
    await expect(page.getByText('2 users')).toBeVisible();
    await byTestId(page, 'users-search').fill('sofia');
    await expect(page.getByText('1 users')).toBeVisible();
    await expect(byTestId(page, 'user-row-5')).toContainText('Freelancer');
    await byTestId(page, 'user-row-5').click();
    await expectScreen(page, 'user');
    await expect(headerTitle(page)).toHaveText('Sofia');
  });

  test('V-71 add a user (and a duplicate email), then edit', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/users');
    await byTestId(page, 'users-add').click();
    await expect(sheet(page, 'user')).toContainText('Add user');
    await page.getByTestId('user-save').click();
    await expect(sheet(page, 'user').getByTestId('field-error').first()).toHaveText('Required');
    await page.getByTestId('user-name').fill('Nina Dahl');
    await page.getByTestId('user-email').fill('chary@viljetech.com');
    await page.getByTestId('user-save').click();
    await expect(toast(page)).toHaveText('Someone already uses that email');
    await page.getByTestId('user-email').fill('nina@viljetech.com');
    await page.getByTestId('user-devtype').selectOption('QA');
    await page.getByTestId('user-emp-freelancer').click();
    await expect(sheet(page, 'user')).toContainText('Freelancers log time without idle time.');
    await page.getByTestId('user-access-dacop').click();
    await page.getByTestId('user-save').click();
    await expect(toast(page)).toHaveText('Invite sent to nina@viljetech.com');
    await expect(byTestId(page, 'users-list')).toContainText('Nina Dahl');
    await expect(byTestId(page, 'users-list')).toContainText('nina@viljetech.com · QA · Freelancer');
    await byTestId(page, 'users-list').getByRole('button', { name: 'Nina Dahl' }).click();
    await expectScreen(page, 'user');
    await expect(byTestId(page, 'user-projects')).toContainText('Daco platform');
    await byTestId(page, 'user-edit').click();
    await expect(sheet(page, 'user')).toContainText('Edit user');
    await expect(page.getByTestId('user-name')).toHaveValue('Nina Dahl');
    await page.getByTestId('user-role').selectOption('pm');
    await page.getByTestId('user-save').click();
    await expect(toast(page)).toHaveText('User saved');
    await expect(headerTitle(page)).toHaveText('Nina Dahl');
    await expect(byTestId(page, 'header-sub')).toHaveText('Project manager');
  });

  test('V-72 deactivate (cannot sign in), activate, remove a user', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/user/3');
    await expectScreen(page, 'user');
    await expect(byTestId(page, 'user-hero')).toContainText('Active');
    await byTestId(page, 'user-active').click();
    await expect(toast(page)).toHaveText('User deactivated');
    await expect(byTestId(page, 'user-hero')).toContainText('Deactivated');
    await signOut(page);
    await page.getByTestId('account-dev').click();
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toContainText('deactivated');
    await page.getByTestId('account-super').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await openRoute(page, '/users');
    await byTestId(page, 'user-row-3').click();
    await byTestId(page, 'user-active').click();
    await expect(toast(page)).toHaveText('User activated');
    await byTestId(page, 'user-remove').click();
    await expect(page.getByTestId('confirm-remove')).toContainText('Remove Chary?');
    await expect(page.getByTestId('confirm-remove')).toContainText('Their time history is kept. They can no longer sign in.');
    await page.getByTestId('confirm-remove-ok').click();
    await expect(toast(page)).toHaveText('User removed');
    await expectScreen(page, 'users');
    await expect(byTestId(page, 'user-row-3')).toHaveCount(0);
  });

  test('user detail: staff week, check-ins, leave balance; client info; super cannot be removed', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/user/3');
    await expect(byTestId(page, 'user-week')).toBeVisible();
    await expect(byTestId(page, 'user-checkins')).toContainText('Mon 5 Oct');
    await expect(byTestId(page, 'user-annual-left')).toContainText('23 days');
    await expect(byTestId(page, 'user-leave')).toContainText('Family trip');
    await openRoute(page, '/user/7');
    await expect(page.getByText("Client users don't log time, attendance or leave. Only their project access is shown.")).toBeVisible();
    await expect(byTestId(page, 'user-week')).toHaveCount(0);
    await openRoute(page, '/user/1');
    await expect(byTestId(page, 'user-edit')).toBeVisible();
    await expect(byTestId(page, 'user-remove')).toHaveCount(0);
  });

  test('V-73 add leave as admin (approved) and as a developer from My leave (pending)', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/users');
    await byTestId(page, 'users-seg-leave').click();
    await byTestId(page, 'users-leave-add').click();
    await expect(sheet(page, 'leave')).toBeVisible();
    await page.getByTestId('leave-who').selectOption('Sofia');
    await page.getByTestId('leave-kind-Sick').click();
    await page.getByTestId('leave-from').fill('2026-10-14');
    await page.getByTestId('leave-to').fill('2026-10-13');
    await page.getByTestId('leave-save').click();
    await expect(toast(page)).toHaveText('End date is before start date');
    await page.getByTestId('leave-to').fill('2026-10-15');
    await page.getByTestId('leave-reason').fill('Flu');
    await page.getByTestId('leave-save').click();
    await expect(toast(page)).toHaveText('Leave added');
    await expect(byTestId(page, 'leave-decided')).toContainText('Sofia · Sick leave');
    await expect(byTestId(page, 'leave-decided')).toContainText('14 Oct – 15 Oct · 2 days · Flu');
    await signOut(page);
    await page.getByTestId('account-dev').click();
    await page.getByTestId('sign-in-submit').click();
    await goTab(page, 'more');
    await byTestId(page, 'more-page-leave').click();
    await expectScreen(page, 'leave');
    await expect(byTestId(page, 'kpi-annual-left')).toContainText('23 days');
    await byTestId(page, 'my-leave-add').click();
    await expect(page.getByTestId('leave-who')).toHaveCount(0);
    await page.getByTestId('leave-from').fill('2026-12-21');
    await page.getByTestId('leave-to').fill('2026-12-23');
    await page.getByTestId('leave-save').click();
    await expect(toast(page)).toHaveText('Request sent for approval');
    await expect(byTestId(page, 'my-leave-pending')).toContainText('21 Dec – 23 Dec · 3 days');
    await expect(byTestId(page, 'kpi-pending')).toContainText('2');
    // a developer can read a request but not decide it
    await byTestId(page, 'my-leave-pending').getByRole('button').first().click();
    await expect(page.getByTestId('sheet-approve')).toContainText('Admins approve leave and comp-off.');
    await expect(page.getByTestId('approve-approve')).toHaveCount(0);
  });

  test('V-74 approve and reject leave', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/users');
    await byTestId(page, 'users-seg-leave').click();
    await byTestId(page, 'leave-1').click();
    await expect(page.getByTestId('sheet-approve')).toContainText('Annual leave');
    await expect(page.getByTestId('sheet-approve')).toContainText('Chary');
    await expect(page.getByTestId('sheet-approve')).toContainText('Family trip');
    await page.getByTestId('approve-approve').click();
    await expect(toast(page)).toHaveText('Approved');
    await expect(byTestId(page, 'leave-decided').getByTestId('leave-1')).toContainText('Approved');
    await byTestId(page, 'leave-2').click();
    await page.getByTestId('approve-reject').click();
    await expect(toast(page)).toHaveText('Rejected');
    await expect(byTestId(page, 'leave-decided').getByTestId('leave-2')).toContainText('Rejected');
    await expect(byTestId(page, 'users-seg-leave')).toContainText('2');
    // the approved days come off Chary's balance
    await openRoute(page, '/user/3');
    await expect(byTestId(page, 'user-annual-left')).toContainText('20 days');
  });

  test('V-75 toggle a permission and see its effect (pm loses "+" on Companies)', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/companies');
    await expect(byTestId(page, 'companies-add')).toBeVisible();
    await signOut(page);
    await page.getByTestId('account-admin').click();
    await page.getByTestId('sign-in-submit').click();
    await openRoute(page, '/users');
    await byTestId(page, 'users-seg-perms').click();
    await byTestId(page, 'perm-role-pm').click();
    await expect(byTestId(page, 'perm-companies.edit')).toHaveAttribute('aria-checked', 'true');
    await byTestId(page, 'perm-companies.edit').click();
    await expect(byTestId(page, 'perm-companies.edit')).toHaveAttribute('aria-checked', 'false');
    await signOut(page);
    await page.getByTestId('account-pm').click();
    await page.getByTestId('sign-in-submit').click();
    await openRoute(page, '/companies');
    await expectScreen(page, 'companies');
    await expect(byTestId(page, 'companies-add')).toHaveCount(0);
    await byTestId(page, 'company-row-daco').click();
    await expect(byTestId(page, 'company-edit')).toHaveCount(0);
    await expect(byTestId(page, 'company-archive')).toHaveCount(0);
  });

  test('V-75 the permission matrix is read-only for nobody but super and admin', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/users');
    await byTestId(page, 'users-seg-perms').click();
    await byTestId(page, 'perm-role-dev').click();
    await expect(byTestId(page, 'perm-tickets.create')).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'perm-users.manage')).toHaveAttribute('aria-checked', 'false');
    await byTestId(page, 'perm-users.manage').click();
    await expect(byTestId(page, 'perm-users.manage')).toHaveAttribute('aria-checked', 'true');
    // a pm cannot open Users at all
    await signOut(page);
    await page.getByTestId('account-pm').click();
    await page.getByTestId('sign-in-submit').click();
    await openRoute(page, '/users');
    await expectScreen(page, 'home');
  });
});

// ── Companies ──────────────────────────────────────────────────────────────

test.describe('companies', () => {
  test('V-80 add a company (opens it, main contact becomes a portal admin)', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/companies');
    await byTestId(page, 'companies-add').click();
    await expect(sheet(page, 'company')).toContainText('Add a company');
    await page.getByTestId('company-save').click();
    await expect(sheet(page, 'company').getByTestId('field-error')).toHaveText('Required');
    await page.getByTestId('company-name').fill('Lofoten Seafood');
    await page.getByTestId('company-industry').fill('Food');
    await page.getByTestId('company-country').selectOption('Norway');
    await page.getByTestId('company-web').fill('lofoten.no');
    await page.getByTestId('company-contact').fill('Siri Lund');
    await page.getByTestId('company-contact-email').fill('siri@lofoten.no');
    await page.getByTestId('company-save').click();
    await expect(toast(page)).toHaveText('Company created');
    await expectScreen(page, 'company');
    await expect(headerTitle(page)).toHaveText('Lofoten Seafood');
    await expect(byTestId(page, 'company-hero')).toContainText('Norway · lofoten.no');
    await expect(byTestId(page, 'company-contacts')).toContainText('Siri Lund');
    await expect(byTestId(page, 'company-contacts')).toContainText('Portal admin');
    await expect(byTestId(page, 'company-projects-empty')).toHaveText('No projects yet');
    await byTestId(page, 'header-back').click();
    await expect(byTestId(page, 'companies-list')).toContainText('Lofoten Seafood');
  });

  test('V-81 edit a company', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/company/fjord');
    await expect(byTestId(page, 'company-about')).toHaveText('No notes yet.');
    await byTestId(page, 'company-edit').click();
    await expect(sheet(page, 'company')).toContainText('Edit company');
    await expect(page.getByTestId('company-name')).toHaveValue('Fjordline Logistics');
    await page.getByTestId('company-notes').fill('Driver app in maintenance.');
    await page.getByTestId('company-save').click();
    await expect(toast(page)).toHaveText('Saved');
    await expect(byTestId(page, 'company-about')).toHaveText('Driver app in maintenance.');
  });

  test('V-82 add, edit and remove a contact', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/company/daco');
    await byTestId(page, 'company-add-contact').click();
    await expect(sheet(page, 'contact')).toContainText('Add a contact');
    await expect(sheet(page, 'contact')).toContainText('Daco');
    await page.getByTestId('contact-save').click();
    await expect(sheet(page, 'contact').getByTestId('field-error')).toHaveCount(2);
    await page.getByTestId('contact-name').fill('Mona Vik');
    await page.getByTestId('contact-email').fill('mona@daco.no');
    await page.getByTestId('contact-role').fill('Designer');
    await page.getByTestId('contact-projects-dacop').click();
    await page.getByTestId('contact-save').click();
    await expect(toast(page)).toHaveText('Contact saved');
    await expect(byTestId(page, 'contact-2')).toContainText('Mona Vik');
    await expect(byTestId(page, 'contact-2')).toContainText('Designer · mona@daco.no');
    await expect(byTestId(page, 'contact-2')).toContainText('Daco platform');
    await byTestId(page, 'contact-2').click();
    await expect(sheet(page, 'contact')).toContainText('Client contact');
    await page.getByTestId('contact-admin').click();
    await page.getByTestId('contact-save').click();
    await expect(toast(page)).toHaveText('Contact saved');
    await expect(byTestId(page, 'contact-2')).toContainText('Portal admin');
    await byTestId(page, 'contact-2').click();
    await page.getByTestId('contact-remove').click();
    await expect(byTestId(page, 'contact-2')).toHaveCount(0);
  });

  test('V-83 archive and restore a company', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/companies');
    await expect(byTestId(page, 'companies-seg-archived')).toHaveText('Archived');
    await byTestId(page, 'company-row-hav').click();
    await byTestId(page, 'company-archive').click();
    await expect(page.getByTestId('confirm-archive')).toContainText('Archive company');
    await page.getByTestId('confirm-archive-ok').click();
    await expect(toast(page)).toHaveText('Company archived');
    await expect(byTestId(page, 'company-archived')).toBeVisible();
    await expect(byTestId(page, 'company-hero')).toContainText('Archived');
    await byTestId(page, 'header-back').click();
    await expect(byTestId(page, 'company-row-hav')).toHaveCount(0);
    await byTestId(page, 'companies-seg-archived').click();
    await byTestId(page, 'company-row-hav').click();
    await byTestId(page, 'company-restore').click();
    await expect(toast(page)).toHaveText('Company restored');
    await expect(byTestId(page, 'company-archived')).toHaveCount(0);
  });

  test('companies: search and permission gating for a developer', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-companies').click();
    await expect(byTestId(page, 'companies-add')).toHaveCount(0);
    await byTestId(page, 'companies-search').fill('nord');
    await expect(byTestId(page, 'companies-list')).toContainText('Nordlys Energi');
    await expect(byTestId(page, 'company-row-daco')).toHaveCount(0);
    await byTestId(page, 'companies-search').fill('zzz');
    await expect(byTestId(page, 'companies-list-empty')).toHaveText('No companies match your search.');
    await byTestId(page, 'companies-search').fill('');
    await byTestId(page, 'company-row-daco').click();
    await expect(byTestId(page, 'company-add-contact')).toHaveCount(0);
    await expect(byTestId(page, 'company-new-project')).toHaveCount(0);
  });
});
