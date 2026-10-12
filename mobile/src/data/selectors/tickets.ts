import { TODAY } from '../clock';
import { PRIORITY, TICKET_STATUS, TICKET_TYPE } from '../constants';
import { diff, sh } from '../format';
import type { AppState } from '../store/state';
import type { Ticket, TicketPrio } from '../types';
import { me } from './session';

/** Tickets in the signed-in person's scope (SPEC §2.1 "My tickets"). */
export function myTickets(s: AppState): Ticket[] {
  const person = me(s);
  if (!person?.role) return [];
  const r = person.role;
  if (r === 'client') return s.tickets.filter((t) => t.client);
  if (r === 'dev' || r === 'free' || r === 'devops') return s.tickets.filter((t) => t.as.includes(person.name));
  return s.tickets.filter((t) => t.proj !== '');
}

export const isOpen = (t: Ticket) => t.st !== 'done';

export function ticketById(s: AppState, id: number): Ticket | undefined {
  return s.tickets.find((t) => t.id === id);
}

export function ticketByKey(s: AppState, key: string): Ticket | undefined {
  return s.tickets.find((t) => t.key === key);
}

export interface DueInfo {
  /** "3d late", "Today", "Tomorrow", "13 Oct", "No date" (done: the date) */
  label: string;
  color: string;
  weight: 600 | 800;
  late: boolean;
  /** days from TODAY, null without a due date */
  days: number | null;
}

/** Due label and colour (prototype dueInfo). Done tickets are never late. */
export function dueInfo(t: Pick<Ticket, 'due' | 'st'>): DueInfo {
  const d = t.due ? diff(t.due, TODAY) : null;
  const done = t.st === 'done';
  const label = !t.due ? 'No date' : done ? sh(t.due) : d! < 0 ? `${-d!}d late` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : sh(t.due);
  const late = !done && d !== null && d < 0;
  const color = late ? '#C0392B' : !done && d === 0 ? '#7A5C0E' : '#1B2D45';
  const weight = !done && d !== null && d <= 0 ? 800 : 600;
  return { label, color, weight, late, days: d };
}

/** Sort by due date, tickets without a date last (prototype order). */
export function byDue(a: Ticket, b: Ticket): number {
  return (a.due || '9') < (b.due || '9') ? -1 : 1;
}

export interface TicketCardVM {
  id: number;
  key: string;
  title: string;
  proj: string;
  epic: string;
  sprint: string;
  type: Ticket['type'];
  typeTone: { soft: string; ink: string; icon: (typeof TICKET_TYPE)[keyof typeof TICKET_TYPE]['icon'] };
  /** show the red Critical badge (staff only) */
  critical: boolean;
  /** priority shown when not critical; clients see Critical as High */
  prio: Exclude<TicketPrio, 'Critical'>;
  prioColor: string;
  prioIcon: (typeof PRIORITY)[keyof typeof PRIORITY]['icon'];
  /** status label for the viewer (client labels for clients) */
  statusLabel: string;
  statusDot: string;
  due: DueInfo;
  assignees: string[];
  subsLabel: string;
  subsPct: number;
  hasSubs: boolean;
  /** ring colour: danger ring for critical cards */
  ring: string;
}

/** TicketCard view model (prototype card()). */
export function ticketCardVM(t: Ticket, viewerIsClient: boolean): TicketCardVM {
  const crit = t.prio === 'Critical';
  const prio = (crit ? 'High' : t.prio) as Exclude<TicketPrio, 'Critical'>;
  const pr = PRIORITY[prio] ?? PRIORITY.Medium;
  const st = TICKET_STATUS[t.st];
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    proj: t.proj,
    epic: t.epic,
    sprint: t.sprint,
    type: t.type,
    typeTone: TICKET_TYPE[t.type],
    critical: crit && !viewerIsClient,
    prio,
    prioColor: pr.color,
    prioIcon: pr.icon,
    statusLabel: viewerIsClient ? st.client : st.label,
    statusDot: st.dot,
    due: dueInfo(t),
    assignees: t.as,
    hasSubs: !!t.subs,
    subsLabel: t.subs ? `${t.subs[0]} of ${t.subs[1]} subtasks` : 'No subtasks',
    subsPct: t.subs && t.subs[1] ? (t.subs[0] / t.subs[1]) * 100 : 0,
    ring: crit && !viewerIsClient ? '#F0C9B8' : '#D6DEE8',
  };
}

/** Open / late / critical counts in the signed-in scope (Home KPIs, More tiles). */
export function myTicketCounts(s: AppState) {
  const mine = myTickets(s);
  const open = mine.filter(isOpen);
  return {
    all: mine.length,
    open: open.length,
    done: mine.length - open.length,
    late: open.filter((t) => dueInfo(t).late).length,
    critical: open.filter((t) => t.prio === 'Critical').length,
  };
}
