import { expect, test } from '@playwright/test';

import {
  ACCOUNTS,
  byTestId,
  expectScreen,
  goTab,
  openSignIn,
  ROLES,
  screen,
  selectedTab,
  signInAs,
  signInWithEmail,
  signOut,
  TAB_LABELS,
  tabBar,
  tabLabels,
  type Role,
} from '../helpers/session';

/** More tiles per role, in order (SPEC.md §2.2). */
const MORE_TILES: Record<Role, string[]> = {
  dev: ['Ticket board', 'Time history', 'Notifications', 'Leave & comp-off'],
  free: ['Ticket board', 'Time history', 'Notifications'],
  pm: ['Ticket board', 'Time history', 'Team hours', 'Companies', 'DevOps board', 'Notifications', 'Leave & comp-off'],
  admin: ['Ticket board', 'Time history', 'Team hours', 'Companies', 'Users & roles', 'DevOps board', 'DevOps settings', 'Notifications', 'Leave & comp-off'],
  super: ['Ticket board', 'Time history', 'Team hours', 'Companies', 'Users & roles', 'DevOps board', 'DevOps settings', 'Notifications', 'Leave & comp-off'],
  devops: ['DevOps settings', 'Ticket board', 'Time history', 'Projects', 'Notifications', 'Leave & comp-off'],
  client: ['Notifications'],
};

/** Home layout per role (SPEC S-HOME variants). */
const HOME_LAYOUT: Record<Role, string> = {
  dev: 'ic', free: 'ic', pm: 'staffAll', admin: 'staffAll', super: 'staffAll', devops: 'devops', client: 'client',
};

const TAB_KEYS: Record<string, string> = {
  Home: 'home', Tickets: 'tickets', Time: 'time', Projects: 'projects', DevOps: 'devops', Questions: 'questions', Bugs: 'bugs', More: 'more',
};

test.describe('M-01 / M-02 sign in', () => {
  test('sign in screen lists the 7 sample accounts', async ({ page }) => {
    await openSignIn(page);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Use your work email to continue.')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveAttribute('placeholder', 'you@company.com');
    for (const r of ROLES) {
      const row = page.getByTestId(`account-${r}`);
      await expect(row).toContainText(ACCOUNTS[r].name);
      await expect(row).toContainText(ACCOUNTS[r].title);
    }
  });

  test('email and demo password sign in (email is case-insensitive)', async ({ page }) => {
    await signInWithEmail(page, '  VIVEK@viljetech.com ');
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.pm);
  });

  test('unknown email shows the error and stays on sign in', async ({ page }) => {
    await signInWithEmail(page, 'nobody@example.com');
    await expect(page.getByTestId('form-error')).toHaveText('We don’t recognise that email.');
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });

  test('wrong password shows the error', async ({ page }) => {
    await signInWithEmail(page, 'chary@viljetech.com', 'nope');
    await expect(page.getByTestId('form-error')).toHaveText('That password is not right.');
  });

  test('empty email asks for the email; typing clears the error', async ({ page }) => {
    await openSignIn(page);
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('form-error')).toHaveText('Enter your email.');
    await page.getByTestId('sign-in-email').fill('c');
    await expect(page.getByTestId('form-error')).toHaveCount(0);
  });
});

test.describe('roles: tabs, Home layout and More tiles', () => {
  for (const role of ROLES) {
    test(`${role}: tab bar, every tab, Home layout, More tiles`, async ({ page }) => {
      await signInAs(page, role);
      expect(await tabLabels(page)).toEqual(TAB_LABELS[role]);
      expect(await selectedTab(page)).toBe('Home');
      await expect(byTestId(page, 'placeholder-params')).toContainText(`"layout":"${HOME_LAYOUT[role]}"`);

      for (const label of TAB_LABELS[role]) {
        const key = TAB_KEYS[label];
        await goTab(page, key);
        expect(await selectedTab(page)).toBe(label);
      }

      const tiles = await screen(page, 'more')
        .locator('[data-testid^="more-tile-"]')
        .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').split(', ')[0]));
      expect(tiles).toEqual(MORE_TILES[role]);
      await expect(byTestId(page, 'more-profile')).toContainText(ACCOUNTS[role].name);
    });
  }

  test('client sees initials, staff see photos', async ({ page }) => {
    await signInAs(page, 'client');
    await expect(byTestId(page, 'header-avatar')).toContainText('IS');
    await expect(byTestId(page, 'header-avatar').locator('img')).toHaveCount(0);
    await signOut(page);
    await page.getByTestId('account-dev').click();
    await expectScreen(page, 'home');
    await expect(byTestId(page, 'header-avatar').locator('img')).toHaveCount(1);
  });

  test('bell badge shows unread notifications (dev 6, free 5)', async ({ page }) => {
    await signInAs(page, 'dev');
    await expect(byTestId(page, 'header-bell')).toHaveAttribute('aria-label', 'Notifications, 6 unread');
    await signOut(page);
    await page.getByTestId('account-free').click();
    await expectScreen(page, 'home');
    await expect(byTestId(page, 'header-bell')).toHaveAttribute('aria-label', 'Notifications, 5 unread');
  });
});

test.describe('M-03 / M-04 / M-47 session', () => {
  test('sign out clears the email and returns to sign in; reload stays signed out', async ({ page }) => {
    await signInWithEmail(page, 'chary@viljetech.com');
    await expectScreen(page, 'home');
    await signOut(page);
    await expect(page.getByTestId('sign-in-email')).toHaveValue('');
    await page.reload();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });

  test('switch account returns to sign in and keeps the email draft', async ({ page }) => {
    await signInWithEmail(page, 'chary@viljetech.com');
    await expectScreen(page, 'home');
    await goTab(page, 'more');
    await byTestId(page, 'more-switch-account').click();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveValue('chary@viljetech.com');
    await page.getByTestId('account-client').click();
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.client);
  });

  test('the session survives a reload', async ({ page }) => {
    await signInAs(page, 'devops');
    await page.reload();
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.devops);
  });

  test('signed-out deep links go to sign in', async ({ page }) => {
    await page.goto('/ticket/1');
    await expect(page.getByTestId('screen-sign-in')).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('navigation shell', () => {
  test('pushed screens keep the owning tab highlighted; Back pops; tabs reset the stack', async ({ page }) => {
    await signInAs(page, 'pm');
    await goTab(page, 'more');
    await byTestId(page, 'more-tile-devops').click();
    await expectScreen(page, 'stack-devops');
    expect(await selectedTab(page)).toBe('More');
    await byTestId(page, 'header-back').click();
    await expectScreen(page, 'more');
    await byTestId(page, 'more-tile-team').click();
    await expectScreen(page, 'team');
    await page.getByTestId('tab-tickets').click();
    await expectScreen(page, 'tickets');
    expect(await selectedTab(page)).toBe('Tickets');
  });

  test('bell opens Notifications and avatar opens Profile, from the current tab', async ({ page }) => {
    await signInAs(page, 'dev');
    await byTestId(page, 'header-bell').click();
    await expectScreen(page, 'inbox');
    expect(await selectedTab(page)).toBe('Home');
    await byTestId(page, 'header-back').click();
    await goTab(page, 'time');
    await byTestId(page, 'header-avatar').click();
    await expectScreen(page, 'me');
    expect(await selectedTab(page)).toBe('Time');
  });

  test('ticket and question hide the tab bar', async ({ page }) => {
    await signInAs(page, 'admin');
    await page.goto('/ticket/1');
    await expectScreen(page, 'ticket');
    await expect(byTestId(page, 'placeholder-title')).toHaveText('PMT-11');
    await expect(tabBar(page)).toHaveCount(0);
    await page.goto('/question/1');
    await expectScreen(page, 'question');
    await expect(tabBar(page)).toHaveCount(0);
  });

  test('sheets open over the screen and close by backdrop and by X', async ({ page }) => {
    await signInAs(page, 'dev');
    await goTab(page, 'time');
    await byTestId(page, 'action-log').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await page.getByTestId('sheet-backdrop').click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId('sheet-log-time')).toHaveCount(0);
    await expectScreen(page, 'time');
    await byTestId(page, 'action-log').click();
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('sheet-log-time')).toHaveCount(0);
  });

  test('toast shows and goes away', async ({ page }) => {
    await page.goto('/dev/kitchen-sink');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('toast')).toHaveText('PMT-22 moved to In progress');
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 5_000 });
  });
});

/** Every placeholder route a feature package replaces, reached by URL. */
const ROUTES: { url: string; screen: string; title: string }[] = [
  { url: '/ticket/1', screen: 'ticket', title: 'PMT-11' },
  { url: '/question/2', screen: 'question', title: 'Question' },
  { url: '/project/Daco%20platform', screen: 'project', title: 'Daco platform' },
  { url: '/company/Daco', screen: 'company', title: 'Daco' },
  { url: '/user/Chary', screen: 'user', title: 'Chary' },
  { url: '/inbox', screen: 'inbox', title: 'Notifications' },
  { url: '/me', screen: 'me', title: 'Profile' },
  { url: '/leave', screen: 'leave', title: 'Leave & comp-off' },
  { url: '/team', screen: 'team', title: 'Team hours' },
  { url: '/companies', screen: 'companies', title: 'Companies' },
  { url: '/users', screen: 'users', title: 'Users' },
  { url: '/dvset', screen: 'dvset', title: 'DevOps settings' },
  { url: '/history', screen: 'history', title: 'Time history' },
  { url: '/board', screen: 'board', title: 'Ticket board' },
  { url: '/stack/projects', screen: 'stack-projects', title: 'Projects' },
  { url: '/stack/devops', screen: 'stack-devops', title: 'DevOps' },
  { url: '/stack/tickets', screen: 'stack-tickets', title: 'Tickets' },
];

const SHEETS: { url: string; id: string; title: string; params?: string }[] = [
  { url: '/sheet/log-time?ticketId=1', id: 'log-time', title: 'Log time', params: '"ticketId":"1"' },
  { url: '/sheet/report?project=Daco%20website&kind=Change', id: 'report', title: 'Report a problem', params: '"kind":"Change"' },
  { url: '/sheet/leave', id: 'leave', title: 'New request' },
  { url: '/sheet/project-status?project=Daco%20platform', id: 'project-status', title: 'Project status', params: '"project":"Daco platform"' },
  { url: '/sheet/support-plan?project=Daco%20intranet', id: 'support-plan', title: 'Set up maintenance', params: '"project":"Daco intranet"' },
];

test.describe('every placeholder route is reachable', () => {
  test('pushed screens by URL', async ({ page }) => {
    test.setTimeout(240_000); // each URL is a full page load
    await signInAs(page, 'admin');
    for (const r of ROUTES) {
      await page.goto(r.url);
      await expectScreen(page, r.screen);
      await expect(byTestId(page, 'placeholder-title')).toHaveText(r.title);
    }
  });

  test('sheet routes by URL, with their params', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, 'admin');
    for (const s of SHEETS) {
      await page.goto(s.url);
      const sheet = page.getByTestId(`sheet-${s.id}`);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(s.title);
      if (s.params) await expect(sheet.getByTestId('placeholder-params')).toContainText(s.params);
    }
  });

  test('Home placeholder links reach every route and Back returns Home', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, 'super');
    const links = await screen(page, 'home').locator('[data-testid^="link-"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid') ?? ''),
    );
    expect(links.length).toBe(22);
    for (const id of links.filter((l) => !l.startsWith('link-Sheet'))) {
      await byTestId(page, id).click();
      await expect(page.locator('[data-testid^="screen-"]').filter({ visible: true }).first()).toBeVisible();
      await expect(screen(page, 'home')).toHaveCount(0);
      await byTestId(page, 'header-back').click();
      await expectScreen(page, 'home');
    }
  });

  test('every pressable has an accessible name', async ({ page }) => {
    await signInAs(page, 'admin');
    for (const key of ['home', 'more']) {
      await goTab(page, key);
      const unnamed = await page.locator('[role=button]:not([aria-label]), [role=tab]:not([aria-label])').count();
      expect(unnamed).toBe(0);
    }
  });
});
