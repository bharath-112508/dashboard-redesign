import { expect, test, type Page } from '@playwright/test';

import {
  ACCESS_DENIED,
  ACCOUNT_KEYS,
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
  TAB_KEYS,
  TAB_LABELS,
  tabBar,
  tabLabels,
  toast,
  type AccountKey,
} from '../helpers/session';

/**
 * F0 shell (mobile-spec-v5): sign-in for all 8 accounts, tabs per role, route guards,
 * every placeholder route reachable, push/pop, URL and inline sheets, toast, persistence.
 */

/** More → Pages per account (SPEC §2.5, plus "Leave" for staff, A-2). */
const MORE_PAGES: Record<AccountKey, string[]> = {
  super: ['Companies', 'DevOps board', 'Clients', 'Employee timesheets', 'Users', 'Leave'],
  admin: ['Companies', 'DevOps board', 'Clients', 'Employee timesheets', 'Users', 'Leave'],
  pm: ['Companies', 'Clients', 'Employee timesheets', 'Leave'],
  dev: ['Companies', 'Leave'],
  freelancer: ['Companies', 'Leave'],
  devops: ['Leave'],
  cadmin: ['Your team'],
  cuser: [],
};

/** Dashboard scope line per account (S5-DASH header). */
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

async function morePageLabels(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="more-page-"]')
    .filter({ visible: true })
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

async function expectDenied(page: Page) {
  await expectScreen(page, 'home');
  await expect(toast(page)).toHaveText(ACCESS_DENIED);
}

test.describe('V-01 / V-02 sign in (DECISIONS 7)', () => {
  test('lists the 8 sample accounts with role labels', async ({ page }) => {
    await openSignIn(page);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Use your work email to continue.')).toBeVisible();
    await expect(page.getByTestId('sign-in-email')).toHaveAttribute('placeholder', 'you@company.com');
    for (const k of ACCOUNT_KEYS) {
      const row = page.getByTestId(`account-${k}`);
      await expect(row).toContainText(ACCOUNTS[k].name);
      await expect(row).toContainText(ACCOUNTS[k].email);
      await expect(row).toContainText(ACCOUNTS[k].label);
      if (k === 'freelancer') await expect(row).toContainText('Sofia · Freelancer');
    }
  });

  test('a sample row fills the email and the demo password', async ({ page }) => {
    await openSignIn(page);
    await page.getByTestId('account-cuser').click();
    await expect(page.getByTestId('sign-in-email')).toHaveValue('lars@daco.no');
    await expect(page.getByTestId('sign-in-password')).toHaveValue('demo');
  });

  test('email is trimmed and case-insensitive', async ({ page }) => {
    await signInWithEmail(page, '  VIVEK@viljetech.com ');
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.admin);
  });

  test('errors: no email, unknown email, wrong password, deactivated', async ({ page }) => {
    await openSignIn(page);
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText('Enter your email.');
    await page.getByTestId('sign-in-email').fill('nobody@example.com');
    await page.getByTestId('sign-in-password').fill('demo');
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText("We don't recognise that email.");
    await page.getByTestId('sign-in-email').fill('rahul@viljetech.com');
    await page.getByTestId('sign-in-password').fill('wrong');
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText('That password is not right.');
    await page.getByTestId('sign-in-email').fill('ola@havbruk.no');
    await page.getByTestId('sign-in-password').fill('demo');
    await page.getByTestId('sign-in-submit').click();
    await expect(byTestId(page, 'field-error')).toHaveText('This account is deactivated. Ask an admin to reactivate it.');
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });
});

test.describe('tabs per role (SPEC §1.3)', () => {
  for (const k of ACCOUNT_KEYS) {
    test(`${k} (${ACCOUNTS[k].name}): sign in, tabs, each tab root, More, sign out`, async ({ page }) => {
      await signInAs(page, k);
      expect(await tabLabels(page)).toEqual(TAB_LABELS[k]);
      expect(await selectedTab(page)).toBe('Home');
      await expect(headerTitle(page)).toHaveText('Dashboard');
      await expect(byTestId(page, 'header-sub')).toHaveText(SCOPE[k]);
      const client = k === 'cadmin' || k === 'cuser';
      await expect(byTestId(page, client ? 'header-profile' : 'header-search')).toBeVisible();

      for (const label of TAB_LABELS[k]) {
        await goTab(page, TAB_KEYS[label]);
        expect(await selectedTab(page)).toBe(label);
        await expect(tabBar(page)).toBeVisible();
        await expect(byTestId(page, 'access-denied')).toHaveCount(0);
      }

      // More: profile row, the role's pages, account section
      await goTab(page, 'more');
      await expect(byTestId(page, 'more-profile')).toContainText(ACCOUNTS[k].name);
      await expect(byTestId(page, 'more-profile')).toContainText(`${ACCOUNTS[k].label}${k === 'freelancer' ? ' · Freelancer' : ''} · ${ACCOUNTS[k].org}`);
      expect(await morePageLabels(page)).toEqual(MORE_PAGES[k]);
      if (!MORE_PAGES[k].length) await expect(byTestId(page, 'more-pages-empty')).toHaveText('Everything you can open is in the tab bar.');
      await expect(byTestId(page, 'more-profile-settings')).toBeVisible();
      await signOut(page);
    });
  }

  test('badges: Tickets = unread on my tickets, Questions = open questions', async ({ page }) => {
    await signInAs(page, 'dev');
    await expect(page.getByTestId('tab-tickets')).toContainText('3');
    await signOut(page);
    await page.getByTestId('account-cadmin').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await expect(page.getByTestId('tab-questions')).toContainText('2');
  });
});

test.describe('route guards (DECISIONS 6)', () => {
  const cases: [AccountKey, string][] = [
    ['dev', '/users'],
    ['dev', '/emp'],
    ['dev', '/sheet/user'],
    ['pm', '/dvp/OPS-101'],
    ['freelancer', '/clients'],
    ['devops', '/projects'],
    ['devops', '/ticket/PMT-11'],
    ['cuser', '/emp'],
    ['cuser', '/users'],
    ['cadmin', '/search'],
    ['cadmin', '/companies'],
    ['super', '/devops'],
  ];
  for (const [k, path] of cases) {
    test(`${k} → ${path} is sent Home with a toast`, async ({ page }) => {
      await signInAs(page, k);
      await openRoute(page, path);
      await expectDenied(page);
    });
  }
});

/** Every v5 route and URL sheet, reachable for an allowed role (placeholders or real). */
const STAFF_ROUTES: [string, string][] = [
  ['/search', 'screen-search'],
  ['/me', 'screen-me'],
  ['/leave', 'screen-leave'],
  ['/emp', 'screen-emp'],
  ['/company-time/daco?pf=dacop', 'screen-company-time'],
  ['/companies', 'screen-companies'],
  ['/company/daco', 'screen-company'],
  ['/clients', 'screen-clients'],
  ['/portal/daco', 'screen-portal'],
  ['/users', 'screen-users'],
  ['/user/3', 'screen-user'],
  ['/ticket/PMT-11', 'screen-ticket'],
  ['/subtask/PMT-11.s2', 'screen-subtask'],
  ['/project/dacop?tab=board', 'screen-project'],
  ['/question/1', 'screen-question'],
  ['/bug/cbm1', 'screen-bug'],
  ['/stack/devops', 'screen-devops'],
  ['/dvp/OPS-103?tab=status', 'screen-dvp'],
  ['/request/1', 'screen-request'],
  ['/dvset', 'screen-dvset'],
];
const STAFF_SHEETS: [string, string][] = [
  ['/sheet/log-time?proj=c%3Adacop&key=PMT-11', 'sheet-log-time'],
  ['/sheet/leave', 'sheet-leave'],
  ['/sheet/new-ticket?pid=dacop', 'sheet-new-ticket'],
  ['/sheet/new-project?co=daco', 'sheet-new-project'],
  ['/sheet/project-status?id=dacop', 'sheet-project-status'],
  ['/sheet/support-terms?id=fjp', 'sheet-support-terms'],
  ['/sheet/devops-request?key=OPS-101', 'sheet-devops-request'],
  ['/sheet/new-question?pid=dacop', 'sheet-new-question'],
  ['/sheet/user?id=3', 'sheet-user'],
  ['/sheet/company?id=daco', 'sheet-company'],
  ['/sheet/contact?co=daco', 'sheet-contact'],
];
const CLIENT_ROUTES: [string, string][] = [
  ['/projects', 'screen-projects'],
  ['/questions', 'screen-questions'],
  ['/bugs', 'screen-bugs'],
  ['/users', 'screen-users'],
  ['/me', 'screen-me'],
  ['/ticket/PMT-11', 'screen-ticket'],
  ['/project/dacop', 'screen-project'],
  ['/question/1', 'screen-question'],
  ['/bug/cbm1', 'screen-bug'],
  ['/sheet/support-request?pid=fjp&kind=problem', 'sheet-support-request'],
  ['/sheet/report-bug?pid=dacop', 'sheet-report-bug'],
  ['/sheet/client-member', 'sheet-client-member'],
];

test.describe('every route and URL sheet is reachable', () => {
  test('super: pushed screens', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, 'super');
    for (const [path, id] of STAFF_ROUTES) {
      await openRoute(page, path);
      await expect(byTestId(page, id), path).toBeVisible();
      await expect(tabBar(page), `tab bar on ${path}`).toBeVisible();
      await expect(byTestId(page, 'header-back'), `back on ${path}`).toBeVisible();
      await expect(byTestId(page, 'access-denied')).toHaveCount(0);
    }
  });

  test('super: URL sheets', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, 'super');
    for (const [path, id] of STAFF_SHEETS) {
      await openRoute(page, path);
      await expect(page.getByTestId(id), path).toBeVisible();
    }
  });

  test('cadmin: client routes and sheets', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, 'cadmin');
    for (const [path, id] of CLIENT_ROUTES) {
      await openRoute(page, path);
      await expect(page.getByTestId(id).filter({ visible: true }), path).toBeVisible();
    }
    await openRoute(page, '/users');
    await expect(headerTitle(page)).toHaveText('Your team');
  });

  test('route params reach the screen', async ({ page }) => {
    await signInAs(page, 'super');
    await openRoute(page, '/dvp/OPS-103?tab=requests');
    // W4 replaced the placeholder: the key picks the record, the tab the segment
    await expect(byTestId(page, 'header-sub')).toHaveText('OPS-103 · Weland');
    await expect(byTestId(page, 'dvp-tab-requests')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('navigation, sheets, toast, persistence', () => {
  test('a deep-linked screen highlights the tab that owns it, not Home', async ({ page }) => {
    await signInAs(page, 'pm');
    await openRoute(page, '/ticket/PMT-11');
    await expectScreen(page, 'ticket');
    await expect.poll(() => selectedTab(page)).toBe('Tickets');
    await openRoute(page, '/project/dacop');
    await expectScreen(page, 'project');
    await expect.poll(() => selectedTab(page)).toBe('Projects');
    await openRoute(page, '/companies');
    await expectScreen(page, 'companies');
    await expect.poll(() => selectedTab(page)).toBe('More');
    // choosing a tab resets the stack; a screen pushed from Home keeps Home
    await goTab(page, 'home');
    expect(await selectedTab(page)).toBe('Home');
    await byTestId(page, 'header-search').click();
    await expectScreen(page, 'search');
    expect(await selectedTab(page)).toBe('Home');
    await signOut(page);
    await signInAs(page, 'devops');
    await openRoute(page, '/dvp/OPS-101');
    await expectScreen(page, 'dvp');
    await expect.poll(() => selectedTab(page)).toBe('DevOps');
  });

  test('push and pop keep the tab bar and the owning tab (V-05)', async ({ page }) => {
    await signInAs(page, 'super');
    await goTab(page, 'more');
    await byTestId(page, 'more-page-companies').click();
    await expectScreen(page, 'companies');
    await expect(headerTitle(page)).toHaveText('Companies');
    expect(await selectedTab(page)).toBe('More');
    await byTestId(page, 'header-back').click();
    await expectScreen(page, 'more');
    // tab2 → pushed DevOps board for super
    await byTestId(page, 'more-page-devops').click();
    await expectScreen(page, 'devops');
    expect(await selectedTab(page)).toBe('More');
    // switching tab resets the stack
    await goTab(page, 'projects');
    await goTab(page, 'more');
    await expect(byTestId(page, 'header-back')).toHaveCount(0);
  });

  test('header search opens Search (staff); profile for clients', async ({ page }) => {
    await signInAs(page, 'pm');
    await byTestId(page, 'header-search').click();
    await expectScreen(page, 'search');
    await signOut(page);
    await page.getByTestId('account-cuser').click();
    await page.getByTestId('sign-in-submit').click();
    await expectScreen(page, 'home');
    await byTestId(page, 'header-profile').click();
    await expectScreen(page, 'me');
  });

  test('URL sheet: Log your time opens SH-LOG and closes', async ({ page }) => {
    await signInAs(page, 'devops');
    await byTestId(page, 'dash-log-time').click();
    await expect(page.getByTestId('sheet-log-time')).toBeVisible();
    await expect(page.getByTestId('tab-bar')).toHaveCount(0);
    await page.getByTestId('sheet-log-time-close').click();
    await expect(page.getByTestId('sheet-log-time')).toHaveCount(0);
    await expectScreen(page, 'home');
    await expect(tabBar(page)).toBeVisible();
  });

  test('clients have no Log your time', async ({ page }) => {
    await signInAs(page, 'cadmin');
    await expect(byTestId(page, 'dash-log-time')).toHaveCount(0);
  });

  test('inline sheet, confirm and toast (kitchen sink)', async ({ page }) => {
    await page.goto('/dev/kitchen-sink');
    await expect(page.getByTestId('kitchen-sink')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('ks-open-sheet').click();
    await expect(page.getByTestId('ks-sheet')).toBeVisible();
    await page.getByTestId('pick-review').filter({ visible: true }).last().click();
    await expect(toast(page)).toHaveText('Moved to Review');
    await expect(page.getByTestId('ks-sheet')).toHaveCount(0);
  });

  test('session persists under vt.mobile.v5; the v4 key is removed (DECISIONS 9)', async ({ page }) => {
    await signInAs(page, 'dev');
    await page.evaluate(() => localStorage.setItem('vt.mobile.v4', '{"version":1}'));
    await page.reload();
    await expectScreen(page, 'home');
    expect(await tabLabels(page)).toEqual(TAB_LABELS.dev);
    const keys = await page.evaluate(() => ({ v5: localStorage.getItem('vt.mobile.v5'), v4: localStorage.getItem('vt.mobile.v4') }));
    expect(keys.v4).toBeNull();
    expect(JSON.parse(keys.v5 ?? '{}').version).toBe(2);
    await signOut(page);
    await page.reload();
    await expect(page.getByTestId('screen-sign-in')).toBeVisible();
  });
});
