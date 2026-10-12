import { expect, test, type Page } from '@playwright/test';

import { byTestId, expectScreen, goTab, screen, signInAs, type Role } from '../helpers/session';

/** P3: Projects and Maintenance (S-PROJECTS, S-PROJECT, S-PSS, S-PLAN). */

async function openProjects(page: Page, role: Role) {
  await signInAs(page, role);
  await goTab(page, 'projects');
}

async function openProject(page: Page, role: Role, name: string, filter?: 'maint' | 'done') {
  await openProjects(page, role);
  if (filter) await byTestId(page, `seg-${filter}`).click();
  await byTestId(page, `project-card-${name}`).click();
  await expectScreen(page, 'project');
  await expect(screen(page, 'project').getByRole('heading', { name })).toBeVisible();
}

const project = (page: Page) => screen(page, 'project');
const toast = (page: Page) => page.getByTestId('toast');
const seg = (page: Page, key: string) => byTestId(page, `seg-${key}`);

test.describe('M-24 filter projects', () => {
  test('M-24 dev sees only projects with their work, with filter counts', async ({ page }) => {
    await openProjects(page, 'dev');
    const s = screen(page, 'projects');
    await expect(s.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(seg(page, 'active')).toHaveAttribute('aria-label', 'Active 2');
    await expect(seg(page, 'maint')).toHaveAttribute('aria-label', 'Maintenance 1');
    await expect(seg(page, 'done')).toHaveAttribute('aria-label', 'Completed 0');
    await expect(byTestId(page, 'project-card-Daco platform')).toContainText('2 epics · Mobile app Sprint 2 ends 18 Oct');
    await expect(byTestId(page, 'project-card-Daco intranet')).toContainText('1 epic · Single sign-on Sprint 3 ends 12 Oct');
    await expect(byTestId(page, 'company-Daco')).toContainText('2 projects');
    await expect(s.getByText('Nordlys portal')).toHaveCount(0);
    await seg(page, 'done').click();
    await expect(s.getByText('No projects here.')).toBeVisible();
    await seg(page, 'maint').click();
    const web = byTestId(page, 'project-card-Daco website');
    await expect(web).toContainText('Live since 15 May 2026');
    await expect(web).toContainText('Support until 31 Mar 2027');
    await expect(web).toContainText('6h of 10h support used this month');
  });

  test('M-24 pm sees every company; the filter is remembered', async ({ page }) => {
    await openProjects(page, 'pm');
    await expect(seg(page, 'active')).toHaveAttribute('aria-label', 'Active 5');
    for (const co of ['Daco', 'Nordlys Energi', 'Fjordline Logistics', 'Havbruk AS']) await expect(byTestId(page, `company-${co}`)).toBeVisible();
    await expect(byTestId(page, 'project-card-Fish health dashboard')).toContainText('Starting soon');
    await expect(byTestId(page, 'project-card-Fish health dashboard')).toContainText('Planned');
    await seg(page, 'done').click();
    await expect(byTestId(page, 'project-card-Nordlys website')).toContainText('Completed 30 Jun 2026');
    await expect(screen(page, 'projects').getByText('Daco platform')).toHaveCount(0);
    await page.reload();
    await expectScreen(page, 'projects');
    await expect(seg(page, 'done')).toHaveAttribute('aria-selected', 'true');
  });

  test('M-24 client sees only Daco under "Your projects"', async ({ page }) => {
    await openProjects(page, 'client');
    const s = screen(page, 'projects');
    await expect(s.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    await expect(seg(page, 'active')).toHaveAttribute('aria-label', 'Active 2');
    await expect(seg(page, 'maint')).toHaveAttribute('aria-label', 'Maintenance 1');
    await expect(byTestId(page, 'company-Nordlys Energi')).toHaveCount(0);
  });

  test('M-24 devops opens Projects from More (pushed copy)', async ({ page }) => {
    await signInAs(page, 'devops');
    await goTab(page, 'more');
    await screen(page, 'more').getByRole('button', { name: /^Projects/ }).first().click();
    await expectScreen(page, 'stack-projects');
    await expect(byTestId(page, 'company-Fjordline Logistics')).toBeVisible();
    await byTestId(page, 'project-card-Nordlys portal').click();
    await expectScreen(page, 'project');
  });
});

test.describe('M-25 open a project and switch views', () => {
  test('M-25 building project: overview, List groups, Board columns, Timeline', async ({ page }) => {
    await openProject(page, 'dev', 'Daco platform');
    const p = project(page);
    const ov = byTestId(page, 'project-overview');
    await expect(ov).toContainText('Daco');
    await expect(ov).toContainText('42%');
    await expect(ov).toContainText('2 epics · 5 sprints · 7 tickets');
    // dev cannot change the status: the pill is not a button
    await expect(p.getByRole('button', { name: /Change project status/ })).toHaveCount(0);
    await expect(seg(page, 'list')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'group-todo')).toContainText('To do');
    await expect(byTestId(page, 'group-prog')).toContainText('In progress4');
    await expect(byTestId(page, 'group-review')).toHaveCount(0);
    await expect(byTestId(page, 'ticket-card-PMT-11')).toContainText('Critical');
    await expect(byTestId(page, 'ticket-card-PMT-11')).toContainText('3d late');
    await seg(page, 'board').click();
    for (const c of ['todo', 'prog', 'review', 'done']) await expect(byTestId(page, `column-${c}`)).toBeAttached();
    await expect(byTestId(page, 'column-review')).toContainText('Review0');
    await seg(page, 'tl').click();
    const tl = byTestId(page, 'project-timeline');
    await expect(tl).toContainText('21 Sep – 1 Nov');
    await expect(tl).toContainText('Mobile app · Sprint 2');
    await expect(tl).toContainText('Web app · Sprint 2');
    await expect(tl).toContainText('Today');
  });

  test('M-25 the selected view is remembered per project', async ({ page }) => {
    await openProject(page, 'pm', 'Daco platform');
    await seg(page, 'tl').click();
    await byTestId(page, 'header-back').click();
    await byTestId(page, 'project-card-Daco intranet').click();
    await expect(seg(page, 'list')).toHaveAttribute('aria-selected', 'true');
    await byTestId(page, 'header-back').click();
    await byTestId(page, 'seg-maint').click();
    await byTestId(page, 'project-card-Daco website').click();
    await expect(seg(page, 'sup')).toHaveAttribute('aria-selected', 'true');
    await byTestId(page, 'header-back').click();
    await byTestId(page, 'seg-active').click();
    await byTestId(page, 'project-card-Daco platform').click();
    await expect(seg(page, 'tl')).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expectScreen(page, 'project');
    await expect(seg(page, 'tl')).toHaveAttribute('aria-selected', 'true');
  });

  test('M-25 client sees client labels and only their company (DECISIONS 9)', async ({ page }) => {
    await openProject(page, 'client', 'Daco platform');
    await expect(byTestId(page, 'group-todo')).toContainText('Received');
    await expect(byTestId(page, 'group-prog')).toContainText('Being fixed');
    await expect(byTestId(page, 'ticket-card-PMT-11')).not.toContainText('Critical');
    await page.goto('/project/Nordlys%20portal');
    await expectScreen(page, 'project');
    await expect(project(page).getByText('This project is not available.')).toBeVisible();
    await expect(byTestId(page, 'ticket-card-NRD-9')).toHaveCount(0);
  });

  test('M-25 maintenance project opens on Support with the hero', async ({ page }) => {
    await openProject(page, 'pm', 'Daco website', 'maint');
    const hero = byTestId(page, 'project-hero');
    await expect(hero).toContainText('Daco · Live since 15 May 2026');
    await expect(hero).toContainText('Running · 99.96% uptime');
    await expect(hero).toContainText('31 Mar 2027');
    await expect(byTestId(page, 'hero-open-requests')).toContainText('3');
    await expect(seg(page, 'sup')).toHaveAttribute('aria-selected', 'true');
    await expect(seg(page, 'tree')).toHaveCount(0);
    await seg(page, 'list').click();
    await expect(project(page).getByText('No tickets yet.')).toBeVisible();
  });
});

test.describe('M-26 explore the epics tree', () => {
  test('M-26 expand and collapse epics and sprints, then open a ticket', async ({ page }) => {
    await openProject(page, 'dev', 'Daco platform');
    await seg(page, 'tree').click();
    const p = project(page);
    await expect(p.getByText('Epics & sprints')).toBeVisible();
    await expect(byTestId(page, 'epic-toggle-Mobile app')).toContainText('3 sprints · 1/5 done');
    await expect(byTestId(page, 'epic-toggle-Mobile app')).toContainText('20%');
    // first epic open, active sprint open
    await expect(byTestId(page, 'tree-ticket-PMT-11')).toBeVisible();
    await expect(byTestId(page, 'tree-ticket-PMT-08')).toHaveCount(0);
    await byTestId(page, 'sprint-toggle-Daco platform|Mobile app|Sprint 1').click();
    await expect(byTestId(page, 'tree-ticket-PMT-08')).toBeVisible();
    await byTestId(page, 'sprint-toggle-Daco platform|Mobile app|Sprint 3').click();
    await expect(byTestId(page, 'sprint-Daco platform|Mobile app|Sprint 3')).toContainText('No tickets yet.');
    // second epic closed by default
    await expect(byTestId(page, 'tree-ticket-PMT-20')).toHaveCount(0);
    await byTestId(page, 'epic-toggle-Web app').click();
    await expect(byTestId(page, 'tree-ticket-PMT-20')).toBeVisible();
    await byTestId(page, 'epic-toggle-Mobile app').click();
    await expect(byTestId(page, 'tree-ticket-PMT-11')).toHaveCount(0);
    await byTestId(page, 'tree-ticket-PMT-20').click();
    await expectScreen(page, 'ticket');
    await expect(page).toHaveURL(/\/ticket\/2$/);
  });
});

test.describe('M-27 open a project file', () => {
  test('M-27 files list opens the ticket that holds the file', async ({ page }) => {
    await openProject(page, 'pm', 'Nordlys portal');
    await seg(page, 'files').click();
    const files = byTestId(page, 'project-files');
    await expect(files).toContainText('invoice-oct.pdf');
    await expect(files).toContainText('NRD-9 · Invoice PDF shows wrong VAT');
    await byTestId(page, 'file-invoice-oct.pdf').click();
    await expectScreen(page, 'ticket');
    await expect(page).toHaveURL(/\/ticket\/5$/);
  });

  test('M-27 empty files state', async ({ page }) => {
    await openProject(page, 'pm', 'Daco intranet');
    await seg(page, 'files').click();
    await expect(byTestId(page, 'project-files')).toContainText('No files attached to tickets yet.');
  });
});

test.describe('M-28 change project status', () => {
  test('M-28 pm marks a project Completed from the status sheet', async ({ page }) => {
    await openProject(page, 'pm', 'Daco intranet');
    await byTestId(page, 'project-status-pill').click();
    const sheet = page.getByTestId('sheet-project-status');
    await expect(sheet).toBeVisible();
    for (const t of ['Not started yet', 'Building: sprints, epics and tickets', 'Live. Support plan, requests and upkeep', 'Handed over. No support plan'])
      await expect(sheet).toContainText(t);
    await expect(sheet.getByTestId('status-option-active')).toHaveAttribute('aria-checked', 'true');
    await sheet.getByTestId('status-option-done').click();
    await expect(sheet).toHaveCount(0);
    await expect(toast(page)).toContainText('Daco intranet marked Completed');
    await expect(byTestId(page, 'project-status-pill')).toContainText('Completed');
    await expect(byTestId(page, 'project-overview')).not.toContainText('68%');
    await byTestId(page, 'header-back').click();
    await expect(seg(page, 'done')).toHaveAttribute('aria-label', 'Completed 2');
  });

  test('M-28 backdrop closes the sheet without a change', async ({ page }) => {
    await openProject(page, 'admin', 'Fish health dashboard');
    await byTestId(page, 'project-status-pill').click();
    await page.getByTestId('sheet-backdrop').click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId('sheet-project-status')).toHaveCount(0);
    await expect(byTestId(page, 'project-status-pill')).toContainText('Planned');
  });
});

test.describe('M-29 set up or edit a support plan', () => {
  test('M-29 Maintenance without a plan opens setup; validation; save moves to maintenance', async ({ page }) => {
    await openProject(page, 'pm', 'Daco intranet');
    await byTestId(page, 'project-status-pill').click();
    await page.getByTestId('status-option-maint').click();
    const sheet = page.getByTestId('sheet-support-plan');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Set up maintenance' })).toBeVisible();
    await expect(sheet).toContainText('Daco intranet');
    await expect(sheet.getByRole('radio', { name: 'Hours + SLA' })).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByRole('radio', { name: 'Quote first' })).toHaveAttribute('aria-checked', 'true');
    await expect(sheet).toContainText('10h');
    await sheet.getByRole('button', { name: 'Increase Support hours per month' }).click();
    await expect(sheet).toContainText('11h');
    await expect(page.getByTestId('plan-url')).toHaveAttribute('placeholder', 'e.g. daco.no');
    await page.getByTestId('plan-start').fill('');
    await sheet.getByTestId('plan-save').click();
    await expect(sheet.getByTestId('form-error')).toHaveText('Add the start and renewal dates.');
    await page.getByTestId('plan-start').fill('2026-11-01');
    await expect(sheet.getByTestId('form-error')).toHaveCount(0);
    await page.getByTestId('plan-renew').fill('2026-10-01');
    await sheet.getByTestId('plan-save').click();
    await expect(sheet.getByTestId('form-error')).toHaveText('Renewal must be after the start date.');
    await page.getByTestId('plan-renew').fill('2027-11-01');
    await page.getByTestId('plan-url').fill('intranet.daco.no');
    await sheet.getByRole('radio', { name: '24/7' }).click();
    await sheet.getByTestId('plan-save').click();
    await expect(sheet).toHaveCount(0);
    await expect(toast(page)).toContainText('Daco intranet is now in maintenance');
    await expect(byTestId(page, 'project-hero')).toContainText('Live since 1 Nov 2026');
    await expect(byTestId(page, 'project-hero')).toContainText('1 Nov 2027');
    await expect(seg(page, 'sup')).toHaveAttribute('aria-selected', 'true');
    await expect(byTestId(page, 'hours-card')).toContainText('of 11h');
    await expect(byTestId(page, 'sla-card')).toContainText('Service level · 24/7');
    await expect(byTestId(page, 'sla-card')).toContainText('No requests yet');
    await byTestId(page, 'header-back').click();
    await expect(seg(page, 'maint')).toHaveAttribute('aria-label', 'Maintenance 3');
  });

  test('M-29 Edit plan changes the agreement to SLA only', async ({ page }) => {
    await openProject(page, 'super', 'Daco website', 'maint');
    await byTestId(page, 'support-edit-plan').click();
    const sheet = page.getByTestId('sheet-support-plan');
    await expect(sheet.getByRole('heading', { name: 'Edit support plan' })).toBeVisible();
    await expect(page.getByTestId('plan-start')).toHaveValue('2026-05-15');
    await expect(page.getByTestId('plan-url')).toHaveValue('daco.no');
    await sheet.getByRole('radio', { name: 'SLA only' }).click();
    await expect(sheet).not.toContainText('Support hours per month');
    await expect(sheet.getByTestId('plan-save')).toHaveText('Save plan');
    await sheet.getByTestId('plan-save').click();
    await expect(toast(page)).toContainText('Support plan saved');
    await expect(byTestId(page, 'support-staff')).toContainText('SLA only');
    await expect(byTestId(page, 'hours-card')).toHaveCount(0);
    await expect(byTestId(page, 'hours-chart')).toHaveCount(0);
  });
});

test.describe('M-30 / M-31 / M-32 maintenance support (staff)', () => {
  test('M-30 billing chip flips and the To quote count updates', async ({ page }) => {
    await openProject(page, 'pm', 'Daco website', 'maint');
    await expect(byTestId(page, 'support-staff')).toContainText('Support hours + SLA');
    await expect(byTestId(page, 'hours-card')).toContainText('4h left this month');
    await expect(byTestId(page, 'to-quote')).toContainText('1 requests');
    await expect(screen(page, 'project').getByText('Request queue · 3 open')).toBeVisible();
    const chip = byTestId(page, 'bill-WEB-41');
    await expect(chip).toContainText('Included in plan');
    await chip.click();
    await expect(chip).toContainText('Outside plan · billable');
    await expect(byTestId(page, 'to-quote')).toContainText('2 requests');
    await chip.click();
    await expect(chip).toContainText('Included in plan');
    await expect(byTestId(page, 'request-WEB-36')).toHaveCount(0);
  });

  test('M-31 Assign gives the request to the signed-in person', async ({ page }) => {
    await openProject(page, 'pm', 'Daco website', 'maint');
    const row = byTestId(page, 'request-WEB-38');
    await expect(row).toContainText('Unassigned');
    await byTestId(page, 'assign-WEB-38').click();
    await expect(toast(page)).toContainText('WEB-38 assigned to Vivek');
    await expect(row).toContainText('Vivek');
    await expect(byTestId(page, 'assign-WEB-38')).toHaveCount(0);
  });

  test('M-32 staff toggle any upkeep task', async ({ page }) => {
    await openProject(page, 'admin', 'Daco website', 'maint');
    const t1 = byTestId(page, 'task-t1');
    await expect(t1).toContainText('in 5d');
    await expect(t1).toHaveAttribute('aria-checked', 'false');
    await t1.click();
    await expect(t1).toContainText('Done');
    await expect(t1).toHaveAttribute('aria-checked', 'true');
    await expect(byTestId(page, 'task-t4')).toContainText('Done');
    await byTestId(page, 'task-t4').click();
    await expect(byTestId(page, 'task-t4')).toContainText('5d late');
  });

  test('M-32 IC staff see and toggle only their own tasks', async ({ page }) => {
    await openProject(page, 'dev', 'Daco website', 'maint');
    await expect(byTestId(page, 'requests')).toContainText('WEB-41');
    await expect(byTestId(page, 'requests')).not.toContainText('WEB-40');
    await expect(byTestId(page, 'environments')).toContainText('staging.daco.no');
    await expect(byTestId(page, 'environments')).toContainText('Live version v2.4.1 · deployed 2 Oct');
    const tasks = byTestId(page, 'tasks');
    await expect(tasks).toContainText('Monthly dependency updates');
    await expect(tasks).not.toContainText('Backup restore test');
    await byTestId(page, 'task-t3').click();
    await expect(byTestId(page, 'task-t3')).toContainText('Done');
    await expect(byTestId(page, 'bill-WEB-41')).toHaveCount(0);
  });

  test('M-32 freelancer: Driver app requests and tasks', async ({ page }) => {
    await openProject(page, 'free', 'Driver app', 'maint');
    await expect(byTestId(page, 'requests')).toContainText('DRV-12');
    await expect(byTestId(page, 'tasks')).toContainText('iOS SDK update check');
  });
});

test.describe('M-33 monthly report', () => {
  test('M-33 staff: months, live October, download and send', async ({ page }) => {
    await openProject(page, 'pm', 'Daco website', 'maint');
    await byTestId(page, 'support-report').click();
    await expect(seg(page, 'rep')).toHaveAttribute('aria-selected', 'true');
    const card = byTestId(page, 'report-card');
    await expect(byTestId(page, 'month-Sep')).toHaveAttribute('aria-checked', 'true');
    await expect(card).toContainText('September 2026');
    await expect(card).toContainText('Sent to client on 1 Oct');
    await expect(card).toContainText('7h of 10h');
    await expect(card).toContainText('3 of 3');
    await expect(card).toContainText('99.98%');
    await byTestId(page, 'month-Oct').click();
    await expect(card).toContainText('October 2026 · so far');
    await expect(card).toContainText('1 at risk');
    await expect(byTestId(page, 'work-done')).toContainText('Fixed WEB-36 · Images slow on mobile');
    await byTestId(page, 'report-download').click();
    await expect(toast(page)).toContainText('Oct report downloaded');
    await byTestId(page, 'report-send').click();
    await expect(toast(page)).toContainText('Oct report sent to client');
  });

  test('M-33 SLA-only plan shows Hours worked; client has no Send', async ({ page }) => {
    await openProject(page, 'pm', 'Driver app', 'maint');
    await expect(byTestId(page, 'hours-card')).toHaveCount(0);
    await expect(byTestId(page, 'support-staff')).toContainText('SLA only');
    await seg(page, 'rep').click();
    await expect(byTestId(page, 'report-card')).toContainText('Hours worked');
    await expect(byTestId(page, 'report-card')).toContainText('Not sent yet');
  });

  test('M-33 client opens the report from Support', async ({ page }) => {
    await openProject(page, 'client', 'Daco website', 'maint');
    await byTestId(page, 'support-monthly-report').click();
    await expect(byTestId(page, 'report-card')).toContainText('September 2026');
    await expect(byTestId(page, 'report-send')).toHaveCount(0);
    await byTestId(page, 'report-download').click();
    await expect(toast(page)).toContainText('Sep report downloaded');
  });
});

test.describe('Entry buttons M-22 / M-34', () => {
  test('M-22 client Support: health, requests and the report / change buttons', async ({ page }) => {
    await openProject(page, 'client', 'Daco website', 'maint');
    const s = byTestId(page, 'support-client');
    await expect(s).toContainText('Everything is running');
    await expect(s).toContainText('12 Sep · 14 min outage (DNS)');
    await expect(s).toContainText('Sun 19 Oct, 06:00–07:00');
    await expect(byTestId(page, 'requests')).toContainText('WEB-36');
    await expect(byTestId(page, 'request-WEB-38')).toContainText('Unassigned');
    await expect(byTestId(page, 'releases')).toContainText('v2.4.1');
    await byTestId(page, 'support-report-problem').click();
    await expect(page.getByTestId('sheet-report')).toBeVisible();
    await expect(page).toHaveURL(/\/sheet\/report\?project=Daco%20website&kind=Bug/);
    await page.goBack();
    await expectScreen(page, 'project');
    await byTestId(page, 'support-request-change').click();
    await expect(page.getByTestId('sheet-report')).toBeVisible();
    await expect(page).toHaveURL(/kind=Change/);
  });

  test('M-34 IC "Log time to support plan" opens the log sheet with the project', async ({ page }) => {
    await openProject(page, 'dev', 'Daco website', 'maint');
    await byTestId(page, 'support-log-time').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page).toHaveURL(/\/sheet\/log-time\?project=Daco%20website&text=Daco%20website%20%C2%B7%20support/);
  });
});

test.describe('Accessibility', () => {
  test('M-25 every pressable on the project views has an accessible name', async ({ page }) => {
    await openProject(page, 'pm', 'Daco website', 'maint');
    const unnamed = () => page.locator('[role=button]:not([aria-label]), [role=tab]:not([aria-label]), [role=checkbox]:not([aria-label])').count();
    expect(await unnamed()).toBe(0);
    await seg(page, 'rep').click();
    expect(await unnamed()).toBe(0);
    await byTestId(page, 'header-back').click();
    await byTestId(page, 'seg-active').click();
    await byTestId(page, 'project-card-Daco platform').click();
    await seg(page, 'tree').click();
    expect(await unnamed()).toBe(0);
  });
});
