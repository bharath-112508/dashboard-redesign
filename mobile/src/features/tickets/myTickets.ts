import { TODAY } from '@/data/clock';
import { diff, fmt, plural } from '@/data/format';
import { epicName, project, sprint } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Ticket } from '@/data/types';

/** S5-MYTICKETS segments and groupings. */
export type MyView = 'now' | 'crit' | 'all';
export type Grouping = 'due' | 'sprint' | 'proj';

/**
 * "Needs you now": not done, and any of: due within 2 days (or overdue), Critical,
 * unread comments, or in Review.
 */
export function needsYouNow(t: Ticket): boolean {
  if (t.st === 'done') return false;
  return (!!t.due && diff(t.due, TODAY) <= 2) || t.prio === 'Critical' || t.unread > 0 || t.st === 'review';
}

export const isOpenCritical = (t: Ticket): boolean => t.st !== 'done' && t.prio === 'Critical';

/** The tickets of a segment. */
export function filterView(L: Ticket[], v: MyView): Ticket[] {
  if (v === 'now') return L.filter(needsYouNow);
  if (v === 'crit') return L.filter(isOpenCritical);
  return L;
}

/** Not-done first, then by due date (no date last). */
export function sortTickets(L: Ticket[]): Ticket[] {
  return L.slice().sort((a, b) => Number(a.st === 'done') - Number(b.st === 'done') || (a.due || '9').localeCompare(b.due || '9'));
}

const DUE_ORDER = ['Overdue', 'Today', 'This week', 'Later', 'No due date', 'Done'];

/** The due-date group of a ticket. */
export function dueGroup(t: Ticket): string {
  if (t.st === 'done') return 'Done';
  if (!t.due) return 'No due date';
  const d = diff(t.due, TODAY);
  return d < 0 ? 'Overdue' : d === 0 ? 'Today' : d <= 7 ? 'This week' : 'Later';
}

export interface TicketGroup {
  title: string;
  /** "1 ticket" / "3 tickets" */
  sub: string;
  tickets: Ticket[];
}

/** Groups by due date (fixed order), sprint ("Epic · Sprint N" / Backlog) or project. */
export function groupTickets(s: AppState, L: Ticket[], g: Grouping): TicketGroup[] {
  const key = (t: Ticket): string => {
    if (g === 'proj') return project(s, t.projectId)?.name ?? 'Other';
    if (g === 'sprint') {
      const sp = sprint(s, t.sprintId);
      return sp ? `${epicName(s, sp.epicId)} · ${sp.name}` : 'Backlog';
    }
    return dueGroup(t);
  };
  const map = new Map<string, Ticket[]>();
  for (const t of sortTickets(L)) {
    const k = key(t);
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  const order = g === 'due' ? DUE_ORDER.filter((k) => map.has(k)) : [...map.keys()];
  return order.map((k) => ({ title: k, sub: plural(map.get(k)!.length, 'ticket'), tickets: map.get(k)! }));
}

export interface DoneOf {
  title: string;
  done: number;
  total: number;
  caption: string;
}

/** "My sprints": active sprints of my tickets, done of mine. */
export function mySprints(s: AppState, A: Ticket[]): DoneOf[] {
  const ids = [...new Set(A.map((t) => t.sprintId).filter((x): x is string => !!x))];
  return ids
    .map((id) => sprint(s, id))
    .filter((sp): sp is NonNullable<typeof sp> => !!sp && sp.state === 'active')
    .map((sp) => {
      const mine = A.filter((t) => t.sprintId === sp.id);
      const done = mine.filter((t) => t.st === 'done').length;
      return {
        title: `${epicName(s, sp.epicId)} · ${sp.name}`,
        done,
        total: mine.length,
        caption: `${done} of ${mine.length} of my tasks done · ends ${fmt(sp.end)}`,
      };
    });
}

/** "My epics": done of mine per epic. */
export function myEpics(s: AppState, A: Ticket[]): DoneOf[] {
  const ids = [...new Set(A.map((t) => t.epicId))];
  return ids.map((e) => {
    const mine = A.filter((t) => t.epicId === e);
    const done = mine.filter((t) => t.st === 'done').length;
    return { title: epicName(s, e), done, total: mine.length, caption: `${done} of ${mine.length} done` };
  });
}
