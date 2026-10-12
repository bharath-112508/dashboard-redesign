import { expect, test, type Page } from '@playwright/test';

import { byTestId, expectScreen, goTab, headerTitle, openRoute, signInAs, signOut, toast } from '../helpers/session';

/**
 * W2 Projects: S5-PROJECTS, S5-PROJECT (every tab), SH-NEWPROJECT, SH-PROJSTATUS,
 * SH-SUPTERMS, SH-SUPREQ and the inline sprint / epic / team sheets.
 * Every W2 flow (V-16, V-40…V-51, V-54, V-55) has a test whose title starts with its id.
 */

const SHOTS = process.env.W2_SHOTS; // folder for 390x844 screenshots (optional)

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openProject(page: Page, id: string, tab?: string) {
  await openRoute(page, `/project/${id}${tab ? `?tab=${tab}` : ''}`);
  await expectScreen(page, 'project');
}

async function tab(page: Page, key: string) {
  await byTestId(page, `project-tab-${key}`).click();
  await expect(byTestId(page, `project-tab-${key}`)).toHaveAttribute('aria-selected', 'true');
}

const row = (page: Page, id: string) => byTestId(page, id);

test.describe('Projects list', () => {
  test('V-40 find a project: search, Client/Internal and status chips', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'projects');
    await expect(row(page, 'project-row-dacop')).toBeVisible();
    await shot(page, '020-projects');
    await byTestId(page, 'projects-search').fill('driver');
    await expect(row(page, 'project-row-fjp')).toBeVisible();
    await expect(row(page, 'project-row-dacop')).toHaveCount(0);
    await byTestId(page, 'projects-search').fill('');
    await byTestId(page, 'projects-kind-internal').click();
    await expect(row(page, 'project-row-i1')).toBeVisible();
    await expect(row(page, 'project-row-dacop')).toHaveCount(0);
    await expect(row(page, 'project-row-i1')).toContainText('Internal · Platform & tooling');
    await shot(page, '021-projects-internal');
    await byTestId(page, 'projects-kind-all').click();
    await byTestId(page, 'projects-st-maint').click();
    await expect(row(page, 'project-row-fjp')).toBeVisible();
    await expect(row(page, 'project-row-fjp')).toContainText('Support until 30 Aug');
    await expect(row(page, 'project-row-dacop')).toHaveCount(0);
    await shot(page, '022-projects-maint-filter');
    // search by company
    await byTestId(page, 'projects-st-all').click();
    await byTestId(page, 'projects-search').fill('nordlys');
    await expect(row(page, 'project-row-nordp')).toBeVisible();
    await expect(row(page, 'project-row-nordp')).toContainText('Deadline passed 8 Oct');
    // empty state
    await byTestId(page, 'projects-search').fill('zzz');
    await expect(page.getByText('No projects match these filters.')).toBeVisible();
    // a row opens the project
    await byTestId(page, 'projects-search').fill('');
    await row(page, 'project-row-dacop').click();
    await expectScreen(page, 'project');
    await expect(headerTitle(page)).toHaveText('Daco platform');
  });

  test('V-40 dev sees their projects only and no "+"', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'projects');
    await expect(row(page, 'project-row-dacop')).toBeVisible();
    await expect(row(page, 'project-row-alncp')).toHaveCount(0);
    await expect(byTestId(page, 'header-new-project')).toHaveCount(0);
    await shot(page, '322-dev-projects');
  });
});

test.describe('Start a project and change status', () => {
  test('V-41 start a client project: errors, then land on it', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'projects');
    await byTestId(page, 'header-new-project').click();
    await expect(page.getByTestId('sheet-new-project')).toBeVisible();
    await shot(page, '206-sheet-new-project');
    await page.getByTestId('new-project-save').click();
    await expect(page.getByTestId('field-error')).toHaveCount(2);
    await shot(page, '208-sheet-new-project-error');
    await page.getByTestId('new-project-company').selectOption('hav');
    await page.getByTestId('new-project-name').fill('Fish tracker');
    await page.getByTestId('new-project-due').fill('2027-01-31');
    await page.getByTestId('new-project-team-Chary').click();
    await page.getByTestId('new-project-save').click();
    await expect(toast(page)).toHaveText('Project started');
    await expectScreen(page, 'project');
    await expect(headerTitle(page)).toHaveText('Fish tracker');
    await expect(byTestId(page, 'project-hero')).toContainText('Planned');
    await expect(byTestId(page, 'project-hero')).toContainText('1 people');
    await shot(page, '035-project-planned-empty');
    // the new project is in the list
    await goTab(page, 'projects');
    await byTestId(page, 'projects-search').fill('fish');
    await expect(byTestId(page, 'projects-rows')).toContainText('Havbruk AS');
  });

  test('V-41 start an internal project', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'projects');
    await byTestId(page, 'header-new-project').click();
    await page.getByTestId('new-project-kind-internal').click();
    await expect(page.getByTestId('new-project-company')).toHaveCount(0);
    await page.getByTestId('new-project-area').selectOption('Research');
    await shot(page, '207-sheet-new-project-internal');
    await page.getByTestId('new-project-name').fill('AI spike');
    await page.getByTestId('new-project-save').click();
    await expect(toast(page)).toHaveText('Project started');
    await expect(headerTitle(page)).toHaveText('AI spike');
    await expect(byTestId(page, 'project-hero')).toContainText('Internal · Research');
  });

  test('V-41 from a company: the kind segment is hidden and the company preset', async ({ page }) => {
    await signInAs(page, 'admin');
    await openRoute(page, '/sheet/new-project?co=daco');
    await expect(page.getByTestId('sheet-new-project')).toBeVisible();
    await expect(page.getByTestId('new-project-kind-client')).toHaveCount(0);
    await expect(page.getByTestId('new-project-company')).toHaveValue('daco');
  });

  test('V-42 change status to Maintenance: teal hero and Support default', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop');
    await byTestId(page, 'project-hero-status').click();
    await expect(page.getByTestId('sheet-project-status')).toBeVisible();
    await shot(page, '209-sheet-project-status');
    await page.getByTestId('project-status-maint').click();
    await expect(toast(page)).toHaveText('Status set to Maintenance');
    await expect(byTestId(page, 'project-hero')).toContainText('Maintenance · Daco');
    await expect(byTestId(page, 'project-tab-support')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'support-kpis')).toContainText('0h');
    // Completed sets 100%
    await byTestId(page, 'project-hero-status').click();
    await page.getByTestId('project-status-done').click();
    await expect(toast(page)).toHaveText('Status set to Completed');
    await expect(byTestId(page, 'project-hero')).toContainText('100% done');
  });

  test('V-42 dev cannot change status (no chevron button)', async ({ page }) => {
    await signInAs(page, 'dev');
    await openProject(page, 'dacop');
    await expect(byTestId(page, 'project-hero')).toContainText('Active');
    await expect(byTestId(page, 'project-hero-status')).toHaveCount(0);
  });
});

test.describe('Project tabs', () => {
  test('V-43 every staff tab renders, and KPIs jump to tabs', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, 'super');
    await openProject(page, 'dacop');
    await expect(byTestId(page, 'header-create-ticket')).toBeVisible();
    await expect(byTestId(page, 'project-kpis')).toContainText('Open tickets');
    await expect(page.getByText('Needs attention')).toBeVisible();
    await shot(page, '023-project-overview');
    const checks: [string, string][] = [
      ['board', 'project-board'],
      ['list', 'project-list'],
      ['sprints', 'sprints-mob'],
      ['timeline', 'gantt-sprints'],
      ['files', 'project-file-upload'],
      ['time', 'time-kpis'],
      ['team', 'team-rows'],
    ];
    for (const [t, id] of checks) {
      await tab(page, t);
      await expect(byTestId(page, id), t).toBeVisible();
      await shot(page, `tab-${t}`);
    }
    // "+" only on Overview, Board, List, Epics & sprints
    await expect(byTestId(page, 'header-create-ticket')).toHaveCount(0);
    for (const t of ['devops', 'questions']) {
      await tab(page, t);
      await expect(byTestId(page, 'header-create-ticket')).toHaveCount(0);
    }
    await expect(byTestId(page, 'project-body-questions')).toBeVisible();
    await tab(page, 'devops');
    await expect(byTestId(page, 'project-body-devops')).toBeVisible();
    // Overdue KPI → List filtered to Overdue
    await tab(page, 'overview');
    await byTestId(page, 'kpi-overdue').click();
    await expect(byTestId(page, 'project-tab-list')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'list-st-late')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'ticket-row-PMT-11')).toBeVisible();
    await expect(byTestId(page, 'ticket-row-PMT-12')).toHaveCount(0);
    // Hours KPI → Time
    await tab(page, 'overview');
    await byTestId(page, 'kpi-hours').click();
    await expect(byTestId(page, 'time-kpis')).toBeVisible();
    // "+" opens Create ticket (W1 sheet)
    await tab(page, 'board');
    await byTestId(page, 'header-create-ticket').click();
    await expect(page.getByTestId('sheet-new-ticket')).toBeVisible();
    await expect(page).toHaveURL(/new-ticket\?pid=dacop/);
  });

  test('V-43 client tabs: Overview, Board, Timeline, Questions, Bugs, Files', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await openProject(page, 'dacop');
    await expect(byTestId(page, 'header-create-ticket')).toHaveCount(0);
    await expect(byTestId(page, 'project-hero-status')).toHaveCount(0);
    await expect(byTestId(page, 'project-tab-list')).toHaveCount(0);
    await expect(byTestId(page, 'project-tab-time')).toHaveCount(0);
    await expect(byTestId(page, 'kpi-hours')).toHaveCount(0);
    await expect(page.getByText('Needs attention')).toHaveCount(0);
    await shot(page, '352-cadmin-project-overview');
    await tab(page, 'board');
    await expect(byTestId(page, 'board-col-todo')).toContainText('Received');
    await expect(byTestId(page, 'board-spr-active')).toHaveCount(0);
    await expect(byTestId(page, 'board-card-PMT-16')).toBeVisible(); // clients see every ticket
    await shot(page, '353-cadmin-project-board');
    await tab(page, 'timeline');
    await expect(byTestId(page, 'gantt-tasks')).toBeVisible();
    await tab(page, 'questions');
    await expect(byTestId(page, 'project-body-questions')).toBeVisible();
    await tab(page, 'bugs');
    await expect(byTestId(page, 'project-body-bugs')).toBeVisible();
    await tab(page, 'files');
    await expect(byTestId(page, 'project-files')).toContainText('android-log.txt');
  });

  test('V-43 a client cannot open another company\'s project', async ({ page }) => {
    await signInAs(page, 'cuser');
    await openProject(page, 'nordp');
    await expect(page.getByText('Project not found.')).toBeVisible();
  });

  test('V-44 filter the board by epic and sprint', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'board');
    // Active sprint (default): sprint tickets, no backlog
    await expect(byTestId(page, 'board-card-PMT-11')).toBeVisible();
    await expect(byTestId(page, 'board-card-PMT-16')).toHaveCount(0);
    await shot(page, '024-project-board');
    await byTestId(page, 'board-spr-backlog').click();
    await expect(byTestId(page, 'board-card-PMT-16')).toBeVisible();
    await expect(byTestId(page, 'board-card-PMT-11')).toHaveCount(0);
    await shot(page, '024b-project-board-backlog');
    await byTestId(page, 'board-spr-all').click();
    await byTestId(page, 'board-epic-web').click();
    await expect(byTestId(page, 'board-card-PMT-20')).toBeVisible();
    await expect(byTestId(page, 'board-card-PMT-11')).toHaveCount(0);
    // a card opens the ticket
    await byTestId(page, 'board-card-PMT-20').click();
    await expectScreen(page, 'ticket');
  });

  test('V-44 Active sprint includes support tickets without a sprint', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'fjp', 'board');
    await expect(byTestId(page, 'board-card-FJD-3')).toBeVisible();
    await expect(byTestId(page, 'board-card-FJD-4')).toBeVisible();
  });

  test('V-44 Overview epic row opens the board on that epic', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop');
    await byTestId(page, 'overview-epics').getByRole('button', { name: /Web app/ }).click();
    await expect(byTestId(page, 'project-tab-board')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'board-epic-web')).toHaveAttribute('aria-selected', 'true');
  });

  test('V-45 filter the list: search and status chips', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'list');
    await expect(byTestId(page, 'list-st-open')).toContainText('7');
    await expect(byTestId(page, 'ticket-row-PMT-16')).toContainText('Backlog · Unassigned');
    await shot(page, '025-project-list');
    await byTestId(page, 'list-st-done').click();
    await expect(byTestId(page, 'ticket-row-PMT-22')).toBeVisible();
    await expect(byTestId(page, 'ticket-row-PMT-11')).toHaveCount(0);
    await byTestId(page, 'list-st-all').click();
    await byTestId(page, 'list-search').fill('bankid');
    await expect(byTestId(page, 'ticket-row-PMT-10')).toBeVisible();
    await expect(byTestId(page, 'ticket-row-PMT-22')).toHaveCount(0);
    await byTestId(page, 'list-search').fill('zzz');
    await expect(page.getByText('No tasks match these filters.')).toBeVisible();
  });
});

test.describe('Epics and sprints', () => {
  test('V-46 plan a sprint: + Sprint → Add sprint', async ({ page }) => {
    await signInAs(page, 'pm');
    await openProject(page, 'dacop', 'sprints');
    await byTestId(page, 'add-sprint-mob').click();
    await expect(page.getByTestId('sheet-new-sprint')).toBeVisible();
    await expect(page.getByTestId('new-sprint-start')).toHaveValue('2026-11-02');
    await shot(page, '223-sheet-new-sprint');
    await page.getByTestId('new-sprint-len-1').click();
    await page.getByTestId('new-sprint-save').click();
    await expect(toast(page)).toHaveText('Sprint added');
    await expect(byTestId(page, 'sprints-mob')).toContainText('Sprint 4');
    await expect(byTestId(page, 'sprints-mob')).toContainText('2 Nov – 8 Nov');
  });

  test('V-47 start and complete sprints (one active per epic; unfinished → backlog)', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'sprints');
    // Sprint 3 is planned; Sprint 2 is still active (A-12)
    await byTestId(page, 'sprint-row-m3').click();
    await expect(page.getByTestId('sheet-sprint')).toBeVisible();
    await shot(page, '225-sheet-sprint-planned');
    await page.getByTestId('sprint-start').click();
    await expect(toast(page)).toHaveText('Complete Sprint 2 first');
    await page.getByTestId('sheet-sprint-close').click();
    // complete Sprint 2
    await byTestId(page, 'sprint-row-m2').click();
    await expect(page.getByTestId('sheet-sprint')).toContainText('4 unfinished tasks move to the backlog when you complete the sprint.');
    await shot(page, '224-sheet-sprint-active');
    await page.getByTestId('sprint-complete').click();
    await expect(toast(page)).toHaveText('Sprint 2 completed');
    await expect(byTestId(page, 'sprint-row-m2')).toContainText('Completed');
    await expect(byTestId(page, 'backlog-mob')).toContainText('PMT-11');
    await expect(byTestId(page, 'backlog-mob')).toContainText('PMT-31');
    // now Sprint 3 can start
    await byTestId(page, 'sprint-row-m3').click();
    await page.getByTestId('sprint-start').click();
    await expect(toast(page)).toHaveText('Sprint 3 started');
    await expect(byTestId(page, 'sprint-row-m3')).toContainText('Active');
  });

  test('V-47 a sprint task opens the ticket', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'sprints');
    await byTestId(page, 'sprint-row-m2').click();
    await page.getByTestId('sheet-sprint').getByTestId('ticket-row-PMT-10').click();
    await expectScreen(page, 'ticket');
  });

  test('V-48 move a backlog ticket into a sprint', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'sprints');
    await byTestId(page, 'backlog-row-PMT-16').click();
    await expect(page.getByTestId('sheet-move-sprint')).toBeVisible();
    await expect(page.getByTestId('move-sprint-m1')).toHaveCount(0); // done sprints are not offered
    await shot(page, '226-sheet-move-to-sprint');
    await page.getByTestId('move-sprint-m3').click();
    await expect(toast(page)).toHaveText('Moved');
    await expect(byTestId(page, 'backlog-row-PMT-16')).toHaveCount(0);
    await expect(byTestId(page, 'sprint-row-m3')).toContainText('0 of 1 done');
  });

  test('V-49 create an epic (required fields)', async ({ page }) => {
    await signInAs(page, 'admin');
    await openProject(page, 'i2', 'sprints');
    await expect(byTestId(page, 'epic-i2')).toBeVisible(); // pseudo-epic
    await byTestId(page, 'new-epic').click();
    await page.getByTestId('new-epic-save').click();
    await expect(page.getByTestId('sheet-new-epic').getByTestId('field-error')).toHaveCount(2);
    await shot(page, '227-sheet-new-epic');
    await page.getByTestId('new-epic-name').fill('Case studies');
    await page.getByTestId('new-epic-req').fill('Ten case study pages with photos.');
    await page.getByTestId('new-epic-save').click();
    await expect(toast(page)).toHaveText('Epic created');
    await expect(page.getByText('Case studies', { exact: true }).first()).toBeVisible();
    await expect(byTestId(page, 'epic-i2')).toHaveCount(0); // the pseudo-epic is replaced
  });

  test('V-46 V-47 V-49 permission gating: dev read-only, pm can, admin without sprints.manage cannot', async ({ page }) => {
    await signInAs(page, 'dev');
    await openProject(page, 'dacop', 'sprints');
    await expect(byTestId(page, 'sprints-mob')).toBeVisible();
    await expect(byTestId(page, 'add-sprint-mob')).toHaveCount(0);
    await expect(byTestId(page, 'new-epic')).toHaveCount(0);
    await byTestId(page, 'sprint-row-m2').click();
    await expect(page.getByTestId('sprint-complete')).toHaveCount(0);
    await shot(page, '323-dev-project-sprints-readonly');
    await page.getByTestId('sheet-sprint-close').click();
    await signOut(page);

    await page.getByTestId('account-pm').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await openProject(page, 'dacop', 'sprints');
    await expect(byTestId(page, 'add-sprint-mob')).toBeVisible();
    await expect(byTestId(page, 'new-epic')).toBeVisible();
    await signOut(page);

    // admin with sprints.manage toggled off in the permission matrix (persisted store)
    await page.evaluate(() => {
      const k = 'vt.mobile.v5';
      const s = JSON.parse(localStorage.getItem(k) ?? '{}');
      s.perms.admin['sprints.manage'] = false;
      localStorage.setItem(k, JSON.stringify(s));
    });
    await page.reload();
    await page.getByTestId('account-admin').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await openProject(page, 'dacop', 'sprints');
    await expect(byTestId(page, 'sprints-mob')).toBeVisible();
    await expect(byTestId(page, 'add-sprint-mob')).toHaveCount(0);
    await expect(byTestId(page, 'new-epic')).toHaveCount(0);
  });
});

test.describe('Files, team, time, support', () => {
  test('V-50 upload a project file', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'files');
    await expect(byTestId(page, 'project-files')).toContainText('PMT-11 · 14 KB · 8 Oct');
    await shot(page, '028-project-files');
    await page.getByTestId('project-file-upload-input').setInputFiles({ name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3000) });
    await expect(toast(page)).toHaveText('File added');
    await expect(byTestId(page, 'project-files')).toContainText('brief.pdf');
    await expect(byTestId(page, 'project-files')).toContainText('Project file · 3 KB · 10 Oct');
  });

  test('V-51 edit the project team', async ({ page }) => {
    await signInAs(page, 'pm');
    await openProject(page, 'nordp', 'team');
    await expect(byTestId(page, 'team-rows')).toContainText('Chary');
    await expect(byTestId(page, 'team-contacts')).toBeVisible();
    await byTestId(page, 'team-add').click();
    await expect(page.getByTestId('sheet-team')).toBeVisible();
    await shot(page, '228-sheet-team');
    await page.getByTestId('team-pick-Arjun').click();
    await page.getByTestId('team-save').click();
    await expect(toast(page)).toHaveText('Team updated');
    await expect(byTestId(page, 'team-row-Arjun')).toBeVisible();
    await expect(byTestId(page, 'project-hero')).toContainText('3 people');
  });

  test('V-51 dev has no "+ Add" on Team', async ({ page }) => {
    await signInAs(page, 'dev');
    await openProject(page, 'dacop', 'team');
    await expect(byTestId(page, 'team-rows')).toBeVisible();
    await expect(byTestId(page, 'team-add')).toHaveCount(0);
  });

  test('project Time: Log time opens SH-LOG preset with the project', async ({ page }) => {
    await signInAs(page, 'super');
    await openProject(page, 'dacop', 'time');
    await byTestId(page, 'project-log-time').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page).toHaveURL(/log-time\?proj=c%3Adacop/);
  });

  test('V-54 edit support terms', async ({ page }) => {
    await signInAs(page, 'admin');
    await openProject(page, 'fjp');
    await expect(byTestId(page, 'project-tab-support')).toHaveAttribute('aria-selected', 'true');
    await shot(page, '033-project-maint-support-staff');
    await byTestId(page, 'terms-quota').click();
    await expect(page.getByTestId('sheet-support-terms')).toBeVisible();
    await expect(page.getByTestId('terms-until-input')).toHaveValue('2027-08-30');
    await shot(page, '231-sheet-support-terms');
    await page.getByTestId('terms-quota-input').fill('');
    await page.getByTestId('terms-save').click();
    await expect(page.getByTestId('sheet-support-terms').getByTestId('field-error')).toHaveText('Required');
    await page.getByTestId('terms-quota-input').fill('12');
    await page.getByTestId('terms-until-input').fill('2027-12-31');
    await page.getByTestId('terms-save').click();
    await expect(toast(page)).toHaveText('Support terms saved');
    await expect(byTestId(page, 'support-terms')).toContainText('12h');
    await expect(byTestId(page, 'support-terms')).toContainText('31 Dec');
    await expect(byTestId(page, 'support-kpis')).toContainText('/ 12h');
  });

  test('V-54 dev has no support-terms pencils', async ({ page }) => {
    await signInAs(page, 'dev');
    await openProject(page, 'fjp');
    await expect(byTestId(page, 'terms-quota')).toHaveCount(0);
  });

  test('V-16 dev sees upkeep tasks; a task opens SH-LOG preset with project and text', async ({ page }) => {
    await signInAs(page, 'dev');
    await openProject(page, 'fjp');
    await expect(byTestId(page, 'support-mine-empty')).toContainText('No support tickets assigned to you.');
    await expect(byTestId(page, 'support-upkeep')).toContainText('Monthly dependency updates');
    await expect(byTestId(page, 'support-upkeep')).toContainText('Due 31 Oct');
    await shot(page, '324-dev-project-maint-support');
    await byTestId(page, 'upkeep-1').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page).toHaveURL(/log-time\?proj=c%3Afjp&text=Backup(%20|\+)restore(%20|\+)test/);
    await page.getByTestId('sheet-log-time-close').click();
    await byTestId(page, 'support-log-time').click();
    await expect(page).toHaveURL(/log-time\?proj=c%3Afjp$/);
  });

  test('V-55 client reports a problem and requests a change; staff see them in the queue', async ({ page }) => {
    test.setTimeout(90_000);
    // super puts the Daco project into maintenance so the Daco client gets the Support tab
    await signInAs(page, 'super');
    await openProject(page, 'dacop');
    await byTestId(page, 'project-hero-status').click();
    await page.getByTestId('project-status-maint').click();
    await expect(toast(page)).toHaveText('Status set to Maintenance');
    await signOut(page);

    await page.getByTestId('account-cadmin').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await openProject(page, 'dacop');
    await expect(byTestId(page, 'project-tab-support')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'support-kpis')).toContainText('Support hours left');
    await shot(page, '358-client-project-maint-support');
    await byTestId(page, 'support-report-problem').click();
    await expect(page.getByTestId('sheet-support-request')).toContainText('Report a problem');
    await page.getByTestId('supreq-send').click();
    await expect(page.getByTestId('sheet-support-request').getByTestId('field-error')).toHaveCount(2);
    await page.getByTestId('supreq-title').fill('Login fails on Android');
    await page.getByTestId('supreq-desc').fill('Since this morning nobody can sign in.');
    await page.getByTestId('supreq-prio-Critical').click();
    await shot(page, '370-sheet-report-problem');
    await page.getByTestId('supreq-send').click();
    await expect(toast(page)).toHaveText('Sent to the support team');
    await expect(byTestId(page, 'support-your-requests')).toContainText('Login fails on Android');
    await expect(byTestId(page, 'support-your-requests')).toContainText('Problem · Target 11 Oct');

    await byTestId(page, 'support-request-change').click();
    await expect(page.getByTestId('sheet-support-request')).toContainText('Changes use support hours from your monthly quota.');
    await expect(page.getByTestId('supreq-prio-High')).toHaveCount(0);
    await shot(page, '371-sheet-request-change');
    await page.getByTestId('supreq-title').fill('Add Swedish');
    await page.getByTestId('supreq-desc').fill('Please add Swedish to the app.');
    await page.getByTestId('supreq-send').click();
    await expect(toast(page)).toHaveText('Sent to the support team');
    await expect(byTestId(page, 'support-your-requests')).toContainText('Change request · Target 24 Oct');
    await signOut(page);

    await page.getByTestId('account-pm').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await openProject(page, 'dacop');
    await expect(byTestId(page, 'support-queue')).toContainText('Login fails on Android');
    await expect(byTestId(page, 'support-queue')).toContainText('Add Swedish');
    await expect(byTestId(page, 'project-hero')).toContainText('2 open requests');
  });
});
