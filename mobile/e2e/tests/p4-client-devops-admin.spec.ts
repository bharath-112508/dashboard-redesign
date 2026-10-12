import { expect, test, type Page } from '@playwright/test';

import { byTestId, expectScreen, goTab, screen, signInAs } from '../helpers/session';

/**
 * P4: client portal (Questions, Bugs, Report sheet), DevOps board and settings, and admin
 * (Companies, Users). Every flow ID of P4 (M-21, M-22, M-23, M-37, M-38, M-40, M-41) has a
 * test whose title starts with it. Viewport 390x844 (playwright.config.ts).
 */

const toast = (page: Page) => page.getByTestId('toast');

async function openMoreTile(page: Page, key: string, screenId: string) {
  await goTab(page, 'more');
  await byTestId(page, `more-tile-${key}`).click();
  await expectScreen(page, screenId);
}

test.describe('Client portal', () => {
  test('S-QUESTIONS lists the questions with their derived status', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'questions');
    const q = screen(page, 'questions');
    await expect(q.getByRole('heading', { name: 'Questions' })).toBeVisible();
    await expect(byTestId(page, 'question-card-1')).toContainText('Needs your answer');
    await expect(byTestId(page, 'question-card-1')).toContainText('Asked by Rahul · PMT-10');
    await expect(byTestId(page, 'question-card-2')).toContainText('2 new replies');
    await expect(byTestId(page, 'question-card-3')).toContainText('Solved');
    await expect(byTestId(page, 'question-card-3')).toContainText('1 week ago');
  });

  test('S-QUESTION shows the solved banner and the attachment', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'questions');
    await byTestId(page, 'question-card-3').click();
    await expectScreen(page, 'question');
    await expect(byTestId(page, 'question-solved')).toHaveText('Marked solved by the developer');
    await expect(byTestId(page, 'question-head')).toContainText('push-copy.pdf');
    await expect(byTestId(page, 'question-head')).toContainText('PMT-11');
    await expect(page.getByTestId('tab-bar')).toHaveCount(0);
  });

  test('M-23 client answers a question: status and tab badge update', async ({ page }) => {
    await signInAs(page, 'client');
    const tabQ = page.getByTestId('tab-questions');
    await expect(tabQ.getByLabel('2 new')).toBeVisible();
    await goTab(page, 'questions');
    await byTestId(page, 'question-card-1').click();
    await expectScreen(page, 'question');
    const input = byTestId(page, 'composer-input');
    await expect(input).toHaveAttribute('placeholder', 'Write your answer…');
    await expect(byTestId(page, 'composer-send')).toHaveAttribute('aria-disabled', 'true');
    await input.fill('Norwegian and English only, please.');
    await byTestId(page, 'composer-attach').click();
    await byTestId(page, 'composer-send').click();
    const thread = byTestId(page, 'question-thread');
    await expect(thread).toContainText('Norwegian and English only, please.');
    await expect(thread.getByTestId('question-msg-client')).toContainText('photo-1.jpg');
    await expect(byTestId(page, 'question-head')).toContainText('Waiting for Viljetech');
    await expect(input).toHaveValue('');
    await byTestId(page, 'header-back').click();
    await expectScreen(page, 'questions');
    await expect(byTestId(page, 'question-card-1')).toContainText('Waiting for Viljetech');
    await goTab(page, 'home');
    await expect(tabQ.getByLabel('1 new')).toBeVisible();
  });

  test('M-23 staff reply on a question uses the Viljetech side', async ({ page }) => {
    await signInAs(page, 'admin');
    await page.goto('/question/2');
    await expectScreen(page, 'question');
    const input = byTestId(page, 'composer-input');
    await expect(input).toHaveAttribute('placeholder', 'Reply…');
    await input.fill('Any update on the SVG?');
    await input.press('Enter');
    await expect(byTestId(page, 'question-thread').getByTestId('question-msg-vt').last()).toContainText('Any update on the SVG?');
    await expect(byTestId(page, 'question-head')).toContainText('3 new replies');
  });

  test('S-BUGS lists client bugs, open first, and opens a ticket', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'bugs');
    const cards = screen(page, 'bugs').locator('[data-testid^="bug-card-"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('PMT-35');
    await expect(cards.nth(0)).toContainText('Being fixed');
    await expect(cards.nth(1)).toContainText('Received');
    await expect(cards.nth(1)).toContainText('Chary: Reproduced.');
    await cards.nth(0).click();
    await expectScreen(page, 'ticket');
  });

  test('M-21 client reports a bug: validation, photo, new ticket and toast', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'bugs');
    await byTestId(page, 'action-report').click();
    const sheet = page.getByTestId('sheet-report');
    await expect(sheet).toContainText('Report a problem');
    await expect(sheet.getByRole('radio')).toHaveCount(3);
    await page.getByTestId('report-save').click();
    await expect(page.getByTestId('form-error')).toHaveText('Pick the project the bug is in.');
    await page.getByTestId('report-project-Daco platform').click();
    await expect(page.getByTestId('form-error')).toHaveCount(0);
    await expect(sheet).toContainText('The Viljetech team gets this as a ticket on Daco platform.');
    await page.getByTestId('report-save').click();
    await expect(page.getByTestId('form-error')).toHaveText('Add a title and a description.');
    await page.getByTestId('report-title').fill('Calendar crashes on iPad');
    await page.getByTestId('report-desc').fill('Open calendar, rotate the iPad, the app closes.');
    await page.getByTestId('report-add-photo').click();
    await expect(sheet).toContainText('screenshot-1.png');
    await page.getByTestId('report-save').click();
    await expect(sheet).toHaveCount(0);
    await expect(toast(page)).toHaveText('PMT-36 sent to Viljetech');
    const first = screen(page, 'bugs').locator('[data-testid^="bug-card-"]').first();
    await expect(first).toContainText('PMT-36');
    await expect(first).toContainText('Received');
    await expect(first).toContainText('Calendar crashes on iPad');
  });

  test('M-22 request a change with the project preset (sheet side)', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'bugs');
    await page.goto('/sheet/report?project=Daco%20website&kind=Change');
    const sheet = page.getByTestId('sheet-report');
    await expect(sheet).toContainText('Request a change');
    await expect(page.getByTestId('report-project-Daco website')).toHaveAttribute('aria-checked', 'true');
    await expect(sheet).toContainText('The Viljetech team gets this as a ticket on Daco website.');
    await page.getByTestId('report-title').fill('New footer link');
    await page.getByTestId('report-desc').fill('Add a link to the careers page.');
    await page.getByTestId('report-save').click();
    await expect(toast(page)).toHaveText('PMT-36 sent to Viljetech');
    await expect(sheet).toHaveCount(0);
    await goTab(page, 'bugs');
    await expect(byTestId(page, 'bug-card-PMT-36')).toContainText('New footer link');
  });

  test('M-22 report sheet dismisses by backdrop and discards the form', async ({ page }) => {
    await signInAs(page, 'client');
    await goTab(page, 'bugs');
    await byTestId(page, 'action-report').click();
    await page.getByTestId('report-title').fill('Draft');
    await page.getByTestId('sheet-backdrop').click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId('sheet-report')).toHaveCount(0);
    await byTestId(page, 'action-report').click();
    await expect(page.getByTestId('report-title')).toHaveValue('');
  });
});

test.describe('DevOps', () => {
  test('S-DEVOPS cards show phase, reminder state and CI/CD', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'devops');
    const card = (p: string) => byTestId(page, `devops-card-${p}`);
    await expect(card('Daco platform').getByTestId('devops-reminder')).toHaveText('Reminder 2 · in 3d');
    await expect(card('Nordlys portal').getByTestId('devops-reminder')).toHaveText('Reminder 1 · today');
    await expect(card('Fjordline app').getByTestId('devops-reminder')).toHaveText('Reminder 3 · 1d late');
    await expect(card('Fish health dashboard')).toContainText('5 Dec');
    await expect(card('Daco platform').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(card('Nordlys portal').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  test('M-37 advance a DevOps phase until Live', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'devops');
    await byTestId(page, 'devops-toggle-Daco platform').click();
    const open = byTestId(page, 'devops-expanded-Daco platform');
    await expect(open).toContainText('DEPLOYMENTS', { ignoreCase: true });
    await expect(open).toContainText('rolled back');
    await open.getByTestId('devops-move').click();
    await expect(toast(page)).toHaveText('Daco platform → CI/CD setup');
    const card = byTestId(page, 'devops-card-Daco platform');
    await expect(card.getByTestId('devops-phase')).toHaveText('CI/CD setup');
    await expect(open.getByTestId('devops-log')).toContainText('Ganesh · Moved from First project deployment to CI/CD setup.');
    await expect(open.getByTestId('devops-move')).toHaveText('Move to Live');
    await open.getByTestId('devops-move').click();
    await expect(card.getByTestId('devops-phase')).toHaveText('Live');
    await expect(open.getByTestId('devops-move')).toHaveCount(0);
    // collapses again
    await byTestId(page, 'devops-toggle-Daco platform').click();
    await expect(open).toHaveCount(0);
  });

  test('M-37 pm reaches the pushed DevOps board from More', async ({ page }) => {
    await signInAs(page, 'pm');
    await openMoreTile(page, 'devops', 'stack-devops');
    await byTestId(page, 'devops-toggle-Nordlys portal').click();
    await byTestId(page, 'devops-expanded-Nordlys portal').getByTestId('devops-move').click();
    await expect(toast(page)).toHaveText('Nordlys portal → First project deployment');
  });

  test('M-38 edit DevOps settings: reminders, rules, phases, change log', async ({ page }) => {
    await signInAs(page, 'admin');
    await openMoreTile(page, 'dvset', 'dvset');
    const seq = byTestId(page, 'dvset-sequence');
    await expect(byTestId(page, 'dvset-reminder-0')).toContainText('On phase start');
    const r2 = byTestId(page, 'dvset-reminder-1');
    await expect(r2).toContainText('+3 days');
    await r2.getByRole('button', { name: 'Increase Reminder 2 days' }).click();
    await expect(r2).toContainText('+4 days');
    for (let i = 0; i < 3; i++) await r2.getByRole('button', { name: 'Decrease Reminder 2 days' }).click();
    await expect(r2).toContainText('+1 days');
    await expect(r2.getByRole('button', { name: 'Decrease Reminder 2 days' })).toHaveAttribute('aria-disabled', 'true');
    await byTestId(page, 'dvset-add-reminder').click();
    await expect(seq).toContainText('Reminder 4');
    await expect(byTestId(page, 'dvset-reminder-3')).toContainText('+14 days');

    const rules = byTestId(page, 'dvset-rules');
    const skip = rules.getByRole('switch', { name: 'Skip weekends' });
    await expect(skip).toHaveAttribute('aria-checked', 'false');
    await skip.click();
    await expect(skip).toHaveAttribute('aria-checked', 'true');

    await byTestId(page, 'dvset-phase-up-1').click();
    await expect(byTestId(page, 'dvset-phase-0')).toContainText('Client first tenant setup');
    await expect(byTestId(page, 'dvset-phase-1')).toContainText('Client onboarding');
    await byTestId(page, 'dvset-phase-input').fill('Security review');
    await byTestId(page, 'dvset-phase-add').click();
    await expect(byTestId(page, 'dvset-phase-4')).toContainText('Security review');
    await expect(byTestId(page, 'dvset-phase-5')).toContainText('Live');
    await expect(byTestId(page, 'dvset-phase-input')).toHaveValue('');

    const log = byTestId(page, 'dvset-log');
    await expect(log).toContainText('Added phase Security review');
    await expect(log.locator(':scope > div')).toHaveCount(6);

    // Phase edits change the board's "Move to" target.
    await page.goto('/stack/devops');
    await byTestId(page, 'devops-toggle-Fjordline app').click();
    await expect(byTestId(page, 'devops-expanded-Fjordline app').getByTestId('devops-move')).toHaveText('Move to Security review');
  });
});

test.describe('Admin', () => {
  test('M-40 manage companies: portal chips, Maintenance label, archive and restore', async ({ page }) => {
    await signInAs(page, 'admin');
    await openMoreTile(page, 'companies', 'companies');
    await expect(byTestId(page, 'company-row-Daco')).toContainText('3 projects · 2 contacts');
    await expect(byTestId(page, 'company-row-Havbruk AS')).toContainText('1 project · 0 contacts');
    await byTestId(page, 'seg-archived').click();
    await expect(screen(page, 'companies')).toContainText('No archived companies.');
    await byTestId(page, 'seg-active').click();
    await byTestId(page, 'company-row-Daco').click();
    await expectScreen(page, 'company');
    await expect(screen(page, 'company')).toContainText('142h logged this month');
    await expect(byTestId(page, 'company-project-Daco website')).toContainText('Maintenance · 100%');
    await expect(byTestId(page, 'company-project-Daco platform')).toContainText('Active · 42%');

    const larsTimeline = byTestId(page, 'perm-Lars Moen-Timeline');
    await expect(larsTimeline).toHaveAttribute('aria-checked', 'false');
    await expect(byTestId(page, 'perm-Ingrid Solberg-Timeline')).toHaveAttribute('aria-checked', 'true');
    await larsTimeline.click();
    await expect(larsTimeline).toHaveAttribute('aria-checked', 'true');
    await byTestId(page, 'perm-Lars Moen-Bugs').click();
    await expect(byTestId(page, 'perm-Lars Moen-Bugs')).toHaveAttribute('aria-checked', 'false');

    await byTestId(page, 'company-archive').click();
    await expect(toast(page)).toHaveText('Company archived');
    await expect(byTestId(page, 'company-archive')).toHaveText('Restore company');
    await byTestId(page, 'header-back').click();
    await expectScreen(page, 'companies');
    await expect(byTestId(page, 'company-row-Daco')).toHaveCount(0);
    await byTestId(page, 'seg-archived').click();
    await byTestId(page, 'company-row-Daco').click();
    await expect(byTestId(page, 'perm-Lars Moen-Timeline')).toHaveAttribute('aria-checked', 'true');
    await byTestId(page, 'company-archive').click();
    await expect(toast(page)).toHaveText('Company restored');
    await expect(byTestId(page, 'company-archive')).toHaveText('Archive company');
  });

  test('M-40 a company project opens the project', async ({ page }) => {
    await signInAs(page, 'pm');
    await openMoreTile(page, 'companies', 'companies');
    await byTestId(page, 'company-row-Fjordline Logistics').click();
    await expect(byTestId(page, 'company-project-Driver app')).toContainText('Maintenance · 100%');
    await byTestId(page, 'company-project-Fjordline app').click();
    await expectScreen(page, 'project');
  });

  test('M-41 manage users: change role and deactivate', async ({ page }) => {
    await signInAs(page, 'admin');
    await openMoreTile(page, 'users', 'users');
    const counts = byTestId(page, 'users-role-counts');
    await expect(counts.getByLabel('Admin: 1', { exact: true })).toBeVisible();
    await expect(screen(page, 'users').locator('[data-testid^="user-row-"]')).toHaveCount(6);
    await expect(byTestId(page, 'user-row-Chary')).toContainText('Developer · chary@viljetech.com');
    await byTestId(page, 'user-row-Chary').click();
    await expectScreen(page, 'user');
    await expect(byTestId(page, 'user-role-Developer')).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'user-access')).toHaveText('Assigned projects, own tickets and time');
    await byTestId(page, 'user-role-Admin').click();
    await expect(toast(page)).toHaveText('Chary is now Admin');
    await expect(byTestId(page, 'user-role-Admin')).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'user-access')).toHaveText('All projects, users and settings');
    await byTestId(page, 'user-active').click();
    await expect(toast(page)).toHaveText('Account deactivated');
    await expect(byTestId(page, 'user-active')).toHaveText('Reactivate account');
    await byTestId(page, 'header-back').click();
    await expect(byTestId(page, 'user-row-Chary')).toContainText('Admin · chary@viljetech.com');
    await expect(byTestId(page, 'user-row-Chary')).toContainText('Inactive');
    await expect(counts.getByLabel('Admin: 2', { exact: true })).toBeVisible();
    await expect(counts.getByLabel('Developer: 0', { exact: true })).toBeVisible();
    await byTestId(page, 'user-row-Chary').click();
    await byTestId(page, 'user-active').click();
    await expect(toast(page)).toHaveText('Account reactivated');
  });

  test('every pressable on P4 screens has an accessible name', async ({ page }) => {
    await signInAs(page, 'admin');
    for (const url of ['/companies', '/company/Daco', '/users', '/user/Chary', '/dvset', '/stack/devops', '/question/1']) {
      await page.goto(url);
      await expect(page.locator('[data-testid^="screen-"]').filter({ visible: true }).first()).toBeVisible();
      expect(await page.locator('[role=button]:not([aria-label]), [role=radio]:not([aria-label]), [role=switch]:not([aria-label]), [role=checkbox]:not([aria-label])').count()).toBe(0);
    }
  });
});
