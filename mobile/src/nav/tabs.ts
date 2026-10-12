import type { IconName } from '@/components/icons';
import type { Role } from '@/data/types';

/** Every tab route under src/app/(app)/(tabs)/. */
export type TabKey = 'home' | 'tickets' | 'time' | 'projects' | 'devops' | 'questions' | 'bugs' | 'more';

export const ALL_TABS: readonly TabKey[] = ['home', 'tickets', 'time', 'projects', 'devops', 'questions', 'bugs', 'more'];

export interface TabDef {
  key: TabKey;
  label: string;
  icon: IconName;
}

const T: Record<TabKey, TabDef> = {
  home: { key: 'home', label: 'Home', icon: 'house' },
  tickets: { key: 'tickets', label: 'Tickets', icon: 'ticket' },
  time: { key: 'time', label: 'Time', icon: 'clock-3' },
  projects: { key: 'projects', label: 'Projects', icon: 'folder-kanban' },
  devops: { key: 'devops', label: 'DevOps', icon: 'server' },
  questions: { key: 'questions', label: 'Questions', icon: 'message-circle-question' },
  bugs: { key: 'bugs', label: 'Bugs', icon: 'bug' },
  more: { key: 'more', label: 'More', icon: 'layout-grid' },
};

/** Tab bars by role, in order (SPEC.md §1.4). */
export const TABS_BY_ROLE: Record<Role, readonly TabDef[]> = {
  dev: [T.home, T.tickets, T.time, T.projects, T.more],
  free: [T.home, T.tickets, T.time, T.projects, T.more],
  pm: [T.home, T.projects, T.tickets, T.time, T.more],
  admin: [T.home, T.projects, T.tickets, T.time, T.more],
  super: [T.home, T.projects, T.tickets, T.time, T.more],
  devops: [T.home, T.devops, T.tickets, T.time, T.more],
  client: [T.home, T.projects, T.questions, T.bugs, T.more],
};

export function tabsFor(role: Role): readonly TabDef[] {
  return TABS_BY_ROLE[role];
}

export function isTabOf(role: Role, key: string): boolean {
  return TABS_BY_ROLE[role].some((t) => t.key === key);
}

/**
 * Which Home layout a role gets (SPEC S-HOME variants). P1 renders one per variant.
 */
export type HomeVariant = 'ic' | 'staffAll' | 'devops' | 'client';

export function homeVariant(role: Role): HomeVariant {
  if (role === 'client') return 'client';
  if (role === 'devops') return 'devops';
  if (role === 'pm' || role === 'admin' || role === 'super') return 'staffAll';
  return 'ic';
}
