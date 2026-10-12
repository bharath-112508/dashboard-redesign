import { expect, type Locator, type Page } from '@playwright/test';

/** Sample account keys (D-TST-1): the role, plus "freelancer" for Sofia. */
export type AccountKey = 'super' | 'admin' | 'pm' | 'dev' | 'freelancer' | 'devops' | 'cadmin' | 'cuser';

/** In sign-in order (SPEC §2.1). */
export const ACCOUNT_KEYS: AccountKey[] = ['super', 'admin', 'pm', 'dev', 'freelancer', 'devops', 'cadmin', 'cuser'];

/** Sample accounts (SPEC §2.1, DECISIONS 2). Demo password: "demo". */
export const ACCOUNTS: Record<AccountKey, { name: string; email: string; role: string; label: string; org: string }> = {
  super: { name: 'Rahul', email: 'rahul@viljetech.com', role: 'super', label: 'Super admin', org: 'Viljetech' },
  admin: { name: 'Vivek', email: 'vivek@viljetech.com', role: 'admin', label: 'Admin', org: 'Viljetech' },
  pm: { name: 'Bhavana P', email: 'bhavana@viljetech.com', role: 'pm', label: 'Project manager', org: 'Viljetech' },
  dev: { name: 'Chary', email: 'chary@viljetech.com', role: 'dev', label: 'Developer', org: 'Viljetech' },
  freelancer: { name: 'Sofia', email: 'sofia@freelance.dev', role: 'dev', label: 'Developer', org: 'Viljetech' },
  devops: { name: 'Arjun', email: 'arjun@viljetech.com', role: 'devops', label: 'DevOps engineer', org: 'Viljetech' },
  cadmin: { name: 'Ingrid Solberg', email: 'ingrid@daco.no', role: 'cadmin', label: 'Client admin', org: 'Daco' },
  cuser: { name: 'Lars Moen', email: 'lars@daco.no', role: 'cuser', label: 'Client user', org: 'Daco' },
};

export const DEMO_PASSWORD = 'demo';

const STAFF_TABS = ['Home', 'Projects', 'Tickets', 'Time', 'More'];
const CLIENT_TABS = ['Home', 'Projects', 'Questions', 'Bugs', 'More'];

/** Tab labels per account, in order (SPEC §1.3, D-ROLE-5). */
export const TAB_LABELS: Record<AccountKey, string[]> = {
  super: STAFF_TABS,
  admin: STAFF_TABS,
  pm: STAFF_TABS,
  dev: STAFF_TABS,
  freelancer: STAFF_TABS,
  devops: ['Home', 'DevOps', 'Time', 'More'],
  cadmin: CLIENT_TABS,
  cuser: CLIENT_TABS,
};

/** Tab label → route key. */
export const TAB_KEYS: Record<string, string> = {
  Home: 'home',
  Projects: 'projects',
  Tickets: 'tickets',
  Time: 'time',
  DevOps: 'devops',
  Questions: 'questions',
  Bugs: 'bugs',
  More: 'more',
};

export const ACCESS_DENIED = "You don't have access to this page";

/** Open the app on Sign in (a fresh context starts from the seed). */
export async function openSignIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('screen-sign-in')).toBeVisible({ timeout: 60_000 });
}

/** Sign in with a sample-account row (fills email + "demo") and Sign in; waits for Home. */
export async function signInAs(page: Page, key: AccountKey): Promise<void> {
  await openSignIn(page);
  await page.getByTestId(`account-${key}`).click();
  await page.getByTestId('sign-in-submit').click();
  await expectScreen(page, 'home');
}

/** Sign in with email and password. Does not wait for the result. */
export async function signInWithEmail(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await openSignIn(page);
  await page.getByTestId('sign-in-email').fill(email);
  await page.getByTestId('sign-in-password').fill(password);
  await page.getByTestId('sign-in-submit').click();
}

/** The visible screen with testID `screen-<id>` (tab roots stay mounted, hidden). */
export function screen(page: Page, id: string): Locator {
  return page.getByTestId(`screen-${id}`).filter({ visible: true });
}

export async function expectScreen(page: Page, id: string): Promise<void> {
  await expect(screen(page, id)).toBeVisible();
}

/** Visible element by testID. */
export function byTestId(page: Page, id: string): Locator {
  return page.getByTestId(id).filter({ visible: true });
}

/** The header title of the visible screen. */
export function headerTitle(page: Page): Locator {
  return byTestId(page, 'header-title');
}

export function tabBar(page: Page): Locator {
  return page.getByTestId('tab-bar');
}

/** Tap a tab by route key and wait for its screen. */
export async function goTab(page: Page, key: string): Promise<void> {
  await page.getByTestId(`tab-${key}`).click();
  await expectScreen(page, key);
}

/** Labels of the tab bar, in order. */
export async function tabLabels(page: Page): Promise<string[]> {
  return tabBar(page)
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** The label of the selected tab. */
export async function selectedTab(page: Page): Promise<string> {
  return (await tabBar(page).locator('[role=tab][aria-selected=true]').getAttribute('aria-label')) ?? '';
}

/** Sign out from More (V-03). */
export async function signOut(page: Page): Promise<void> {
  await goTab(page, 'more');
  await byTestId(page, 'more-sign-out').click();
  await expect(page.getByTestId('screen-sign-in')).toBeVisible();
}

/** Deep link to an (app) route while signed in (the session persists in localStorage). */
export async function openRoute(page: Page, path: string): Promise<void> {
  await page.goto(path);
}

/** The toast text. */
export function toast(page: Page): Locator {
  return page.getByTestId('toast');
}
