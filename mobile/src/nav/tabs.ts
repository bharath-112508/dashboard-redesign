import type { IconName } from '@/components/icons';
import type { Role } from '@/data/types';

/**
 * Tab routes under src/app/(app)/(tabs)/. v5 keys map to routes: dash → home,
 * mytickets → tickets, portal → projects (clients).
 */
export type TabKey = 'home' | 'projects' | 'tickets' | 'time' | 'devops' | 'questions' | 'bugs' | 'more';

export const ALL_TABS: readonly TabKey[] = ['home', 'projects', 'tickets', 'time', 'devops', 'questions', 'bugs', 'more'];

export interface TabDef {
  key: TabKey;
  label: string;
  icon: IconName;
}

const T: Record<TabKey, TabDef> = {
  home: { key: 'home', label: 'Home', icon: 'house' },
  projects: { key: 'projects', label: 'Projects', icon: 'folder-kanban' },
  tickets: { key: 'tickets', label: 'Tickets', icon: 'ticket' },
  time: { key: 'time', label: 'Time', icon: 'clock-3' },
  devops: { key: 'devops', label: 'DevOps', icon: 'server' },
  questions: { key: 'questions', label: 'Questions', icon: 'message-circle-question' },
  bugs: { key: 'bugs', label: 'Bugs', icon: 'bug' },
  more: { key: 'more', label: 'More', icon: 'layout-grid' },
};

const STAFF = [T.home, T.projects, T.tickets, T.time, T.more];
const CLIENT = [T.home, T.projects, T.questions, T.bugs, T.more];

/** Tabs per role, in order (SPEC §1.3, D-ROLE-5). DevOps has 4 tabs, every other role 5. */
export const TABS_BY_ROLE: Record<Role, readonly TabDef[]> = {
  super: STAFF,
  admin: STAFF,
  pm: STAFF,
  dev: STAFF,
  devops: [T.home, T.devops, T.time, T.more],
  cadmin: CLIENT,
  cuser: CLIENT,
};

export function tabsFor(role: Role): readonly TabDef[] {
  return TABS_BY_ROLE[role];
}

export function isTabOf(role: Role | null | undefined, key: string): key is TabKey {
  return !!role && TABS_BY_ROLE[role].some((t) => t.key === key);
}

/**
 * The tab that owns a pushed screen when the app was opened on it by a deep link (no tab
 * was chosen yet): the first of the candidates the role has, else Home.
 */
const DEEP_LINK_OWNER: Record<string, readonly TabKey[]> = {
  'ticket/[key]': ['tickets', 'projects'],
  'subtask/[key]': ['tickets', 'projects'],
  'project/[id]': ['projects'],
  'dvp/[key]': ['devops', 'more'],
  'request/[id]': ['devops', 'more'],
  'stack/devops': ['devops', 'more'],
  'question/[id]': ['questions', 'more'],
  'bug/[id]': ['bugs', 'more'],
  'portal/[co]': ['more'],
  clients: ['more'],
  emp: ['more'],
  users: ['more'],
  'user/[id]': ['more'],
  companies: ['more'],
  'company/[id]': ['more'],
  'company-time/[id]': ['more'],
  dvset: ['more'],
  leave: ['more'],
  me: ['more'],
};

export function deepLinkOwner(routeName: string, role: Role | null | undefined): TabKey {
  return (DEEP_LINK_OWNER[routeName] ?? []).find((t) => isTabOf(role, t)) ?? 'home';
}
