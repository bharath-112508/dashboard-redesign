/**
 * Route guards (DECISIONS 6, D-ROLE-8): every route is checked with `can()`; a role
 * without access is sent to its Home with the toast "You don't have access to this
 * page". Page and permission checks come from the data layer.
 */
import { can, isClientRole, myCan, myPerm, perm } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Page, Role } from '@/data/types';

import { isTabOf } from './tabs';

export { can, perm, myCan, myPerm };
export {
  canDv,
  canEditDevopsSettings,
  canEditPermissions,
  canSetProjectStatus,
  isClient,
  isClientRole,
  isFreelancer,
  seesPhotos,
} from '@/data/selectors';

export const ACCESS_DENIED = "You don't have access to this page";

type Rule = (role: Role) => boolean;
const page = (p: Page): Rule => (r) => can(r, p);
const any = (...rules: Rule[]): Rule => (r) => rules.some((f) => f(r));
const staff: Rule = (r) => !isClientRole(r);
const client: Rule = (r) => isClientRole(r);
const all: Rule = () => true;

/**
 * Who may open each route (expo-router route name relative to the (app) group).
 * Tabs are additionally limited to the role's tab bar.
 */
export const ROUTE_ACCESS: Record<string, Rule> = {
  // tab roots
  home: all,
  projects: any(page('Projects'), client),
  tickets: page('Tickets'),
  time: page('Timesheet'),
  devops: page('DevOps Board v6'),
  questions: client,
  bugs: client,
  more: all,
  // pushed screens
  search: staff,
  me: all,
  leave: staff,
  emp: page('Employee Timesheets'),
  'company-time/[id]': page('Companies'),
  companies: page('Companies'),
  'company/[id]': page('Companies'),
  clients: (r) => staff(r) && can(r, 'Clients'),
  'portal/[co]': (r) => staff(r) && can(r, 'Clients'),
  users: page('Users'),
  'user/[id]': (r) => staff(r) && can(r, 'Users'),
  'ticket/[key]': any(page('Tickets'), client),
  'subtask/[key]': any(page('Tickets'), client),
  'project/[id]': any(page('Projects'), client),
  'question/[id]': any(page('Clients'), page('Projects')),
  'bug/[id]': any(page('Clients'), page('Projects')),
  'stack/devops': page('DevOps Board v6'),
  'dvp/[key]': page('DevOps Board v6'),
  'request/[id]': any(page('DevOps Board v6'), page('Projects')),
  dvset: page('DevOps Board v6'),
  // URL sheets
  'sheet/log-time': page('Timesheet'),
  'sheet/leave': staff,
  'sheet/new-ticket': (r) => staff(r) && can(r, 'Projects'),
  'sheet/new-project': (r) => can(r, 'Projects') || can(r, 'Companies'),
  'sheet/project-status': (r) => staff(r) && can(r, 'Projects'),
  'sheet/support-terms': (r) => staff(r) && can(r, 'Projects'),
  'sheet/support-request': client,
  'sheet/devops-request': any(page('Projects'), page('DevOps Board v6')),
  'sheet/new-question': (r) => staff(r) && (can(r, 'Projects') || can(r, 'Clients')),
  'sheet/report-bug': client,
  'sheet/user': (r) => staff(r) && can(r, 'Users'),
  'sheet/company': page('Companies'),
  'sheet/contact': page('Companies'),
  'sheet/client-member': (r) => r === 'cadmin',
};

const TAB_ROUTES: Record<string, true> = { home: true, projects: true, tickets: true, time: true, devops: true, questions: true, bugs: true, more: true };

/** True when `role` may open the (app) route `name` (unknown routes are refused). */
export function canOpenRoute(role: Role | null | undefined, name: string): boolean {
  if (!role) return false;
  const rule = ROUTE_ACCESS[name];
  if (!rule) return false;
  if (name in TAB_ROUTES && !isTabOf(role, name)) return false;
  return rule(role);
}

/** Route name from expo-router segments: ['(app)', 'ticket', '[key]'] → 'ticket/[key]'. */
export function routeNameOf(segments: readonly string[]): string | null {
  const i = segments.indexOf('(app)');
  if (i < 0) return null;
  const rest = segments.slice(i + 1).filter((x) => x !== '(tabs)');
  return rest.length ? rest.join('/') : 'home';
}

/** `canOpenRoute` for the signed-in person. */
export const myRouteAccess = (s: AppState, name: string): boolean => {
  const id = s.session.personId;
  const role = id == null ? null : (s.people.find((p) => p.id === id)?.role ?? null);
  return canOpenRoute(role, name);
};
