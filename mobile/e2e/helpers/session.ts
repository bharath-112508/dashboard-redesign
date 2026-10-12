import { expect, type Locator, type Page } from '@playwright/test';

/** Mobile roles (SPEC.md §2). */
export type Role = 'super' | 'admin' | 'pm' | 'dev' | 'free' | 'devops' | 'client';

export const ROLES: Role[] = ['super', 'admin', 'pm', 'dev', 'free', 'devops', 'client'];

/** Sample accounts, one per role (DATA.md §1.1). Demo password: "demo". */
export const ACCOUNTS: Record<Role, { name: string; title: string; email: string }> = {
  super: { name: 'Rahul', title: 'Super admin', email: 'rahul@viljetech.com' },
  admin: { name: 'Bhavana P', title: 'Admin · Backend developer', email: 'bhavana@viljetech.com' },
  pm: { name: 'Vivek', title: 'Project manager', email: 'vivek@viljetech.com' },
  dev: { name: 'Chary', title: 'Developer · Frontend', email: 'chary@viljetech.com' },
  free: { name: 'Arjun', title: 'Freelancer · Mobile', email: 'arjun@freelance.dev' },
  devops: { name: 'Ganesh', title: 'DevOps engineer', email: 'ganesh@viljetech.com' },
  client: { name: 'Ingrid Solberg', title: 'Daco · Client admin', email: 'ingrid@daco.no' },
};

export const DEMO_PASSWORD = 'demo';

/** Tab labels per role, in order (SPEC.md §1.4). */
export const TAB_LABELS: Record<Role, string[]> = {
  dev: ['Home', 'Tickets', 'Time', 'Projects', 'More'],
  free: ['Home', 'Tickets', 'Time', 'Projects', 'More'],
  pm: ['Home', 'Projects', 'Tickets', 'Time', 'More'],
  admin: ['Home', 'Projects', 'Tickets', 'Time', 'More'],
  super: ['Home', 'Projects', 'Tickets', 'Time', 'More'],
  devops: ['Home', 'DevOps', 'Tickets', 'Time', 'More'],
  client: ['Home', 'Projects', 'Questions', 'Bugs', 'More'],
};

/** Open the app on the Sign in screen (fresh context = seed data). */
export async function openSignIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('screen-sign-in')).toBeVisible({ timeout: 60_000 });
}

/** Sign in by tapping the role's sample account (M-02) and wait for Home. */
export async function signInAs(page: Page, role: Role): Promise<void> {
  await openSignIn(page);
  await page.getByTestId(`account-${role}`).click();
  await expectScreen(page, 'home');
}

/** Sign in with email and password (M-01). Does not wait for the result. */
export async function signInWithEmail(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await openSignIn(page);
  await page.getByTestId('sign-in-email').fill(email);
  await page.getByTestId('sign-in-password').fill(password);
  await page.getByTestId('sign-in-submit').click();
}

/** The visible screen with testID `screen-<id>`. */
export function screen(page: Page, id: string): Locator {
  return page.getByTestId(`screen-${id}`).filter({ visible: true });
}

export async function expectScreen(page: Page, id: string): Promise<void> {
  await expect(screen(page, id)).toBeVisible();
}

/** Visible element by testID (tab roots stay mounted, so filter to the shown one). */
export function byTestId(page: Page, id: string): Locator {
  return page.getByTestId(id).filter({ visible: true });
}

export function tabBar(page: Page): Locator {
  return page.getByTestId('tab-bar');
}

/** Tap a tab by key (home, tickets, time, projects, devops, questions, bugs, more). */
export async function goTab(page: Page, key: string): Promise<void> {
  await page.getByTestId(`tab-${key}`).click();
  await expectScreen(page, key);
}

/** Labels of the tab bar, in order. */
export async function tabLabels(page: Page): Promise<string[]> {
  return tabBar(page).getByRole('tab').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** The label of the selected tab. */
export async function selectedTab(page: Page): Promise<string> {
  return tabBar(page).locator('[role=tab][aria-selected=true]').getAttribute('aria-label') as Promise<string>;
}

/** Sign out from More (M-04). */
export async function signOut(page: Page): Promise<void> {
  await goTab(page, 'more');
  await byTestId(page, 'more-sign-out').click();
  await expect(page.getByTestId('screen-sign-in')).toBeVisible();
}
