import type { IconName } from '@/components/icons';
import { hm } from '@/data/format';
import {
  activeProjectStats,
  capabilities,
  me,
  myTicketCounts,
  pendingApprovals,
  questionsNeedingClient,
  remindersDue,
  unreadCount,
  weekData,
  weekTotals,
} from '@/data/selectors';
import type { AppState } from '@/data/store/state';
import type { Role } from '@/data/types';
import type { MoreKey } from './routes';
import { tabsFor } from './tabs';

/**
 * Candidate tiles per role (prototype AV). Keys that are already tabs are dropped,
 * which yields the table in SPEC.md §2.2.
 */
const AVAILABLE: Record<Role, readonly MoreKey[]> = {
  dev: ['tickets', 'board', 'time', 'history', 'projects', 'inbox', 'leave'],
  free: ['tickets', 'board', 'time', 'history', 'projects', 'inbox'],
  pm: ['tickets', 'board', 'time', 'history', 'team', 'projects', 'companies', 'devops', 'inbox', 'leave'],
  admin: ['tickets', 'board', 'time', 'history', 'team', 'projects', 'companies', 'users', 'devops', 'dvset', 'inbox', 'leave'],
  super: ['tickets', 'board', 'time', 'history', 'team', 'projects', 'companies', 'users', 'devops', 'dvset', 'inbox', 'leave'],
  devops: ['devops', 'dvset', 'tickets', 'board', 'time', 'history', 'projects', 'inbox', 'leave'],
  client: ['projects', 'questions', 'bugs', 'inbox'],
};

/** The More tile keys for a role, in order (SPEC.md §2.2). */
export function moreTileKeys(role: Role): MoreKey[] {
  const tabs = tabsFor(role).map((t) => t.key as string);
  return AVAILABLE[role].filter((k) => !tabs.includes(k));
}

export interface MoreTile {
  key: MoreKey;
  label: string;
  sub: string;
  icon: IconName;
  bg: string;
  fg: string;
  /** red count badge, 0 = none */
  badge: number;
}

/** Tiles with live subtitles and badges for the signed-in person. */
export function moreTiles(s: AppState): MoreTile[] {
  const person = me(s);
  if (!person?.role) return [];
  const role = person.role;
  const caps = capabilities(role);
  const keys = moreTileKeys(role);
  const t = (key: MoreKey, label: string, icon: IconName, bg: string, fg: string, sub: string, badge = 0): MoreTile => ({
    key, label, icon, bg, fg, sub, badge,
  });

  const build = (key: MoreKey): MoreTile => {
    switch (key) {
      case 'tickets':
        return t(key, caps.staffAll ? 'Tickets' : 'My tickets', 'ticket', '#E7EEFB', '#1F3FAF', `${myTicketCounts(s).open} open`);
      case 'time':
        return t(key, 'Timesheet', 'clock-3', '#D6E9E2', '#195040', `${hm(weekTotals(weekData(s, 0)).total)} this week`);
      case 'projects':
        return t(key, caps.isClient ? 'Your projects' : 'Projects', 'folder-kanban', '#E6DFFA', '#3F2E94', `${activeProjectStats(s).count} active`);
      case 'devops': {
        const n = remindersDue(s).length;
        return t(key, 'DevOps board', 'server', '#DFF1F0', '#1F6F6E', `${n} reminders due`, n);
      }
      case 'questions': {
        const n = questionsNeedingClient(s).length;
        return t(key, 'Questions', 'message-circle-question', '#FBE7E3', '#C0392B', `${n} need you`, n);
      }
      case 'bugs':
        return t(key, 'Bugs', 'bug', '#F6DDD0', '#7A3818', `${s.tickets.filter((x) => x.client && x.st !== 'done').length} open`);
      case 'inbox': {
        const n = unreadCount(s);
        return t(key, 'Notifications', 'bell', '#FBEDC2', '#7A5C0E', n ? `${n} unread` : 'All read', n);
      }
      case 'team':
        return t(key, 'Team hours', 'users-round', '#DCE5FA', '#1F3FAF', 'This week');
      case 'companies':
        return t(key, 'Companies', 'building-2', '#FBEDC2', '#7A5C0E', `${s.companies.filter((c) => !c.archived).length} clients`);
      case 'users':
        return t(key, 'Users & roles', 'shield-check', '#E6DFFA', '#3F2E94', `${s.people.filter((p) => p.role).length} accounts`);
      case 'dvset':
        return t(key, 'DevOps settings', 'settings-2', '#DFF1F0', '#1F6F6E', 'Sequences, phases');
      case 'history':
        return t(key, 'Time history', 'history', '#D6E9E2', '#195040', 'Filter & download');
      case 'board':
        return t(key, 'Ticket board', 'square-kanban', '#E7EEFB', '#1F3FAF', 'Epics, sprints, board');
      case 'leave': {
        const n = caps.staffAll
          ? pendingApprovals(s).length
          : s.leaves.filter((l) => l.st === 'Pending' && l.who === person.name).length;
        return t(key, 'Leave & comp-off', 'calendar-days', '#E6DFFA', '#3F2E94', caps.staffAll ? `${n} to approve` : `${n} pending`, caps.staffAll ? n : 0);
      }
    }
  };

  return keys.map(build);
}
