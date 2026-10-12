/**
 * Tickets feature selectors: the Tickets tab groups (S-TICKETS), the ticket board
 * (S-BOARD) and the ticket detail time log (S-TICKET).
 */
import { TICKET_STATUS, TICKET_STATUS_ORDER } from '@/data/constants';
import { byDue, dueInfo, isOpen, me, myTickets } from '@/data/selectors';
import type { AppState, TicketFilter } from '@/data/store/state';
import { ANY_USER, type Ticket, type TicketStatus, type TimeEntry } from '@/data/types';
import { colors } from '@/theme';

export interface TicketGroup {
  key: 'overdue' | 'today' | 'week' | 'later' | 'done';
  label: string;
  dot: string;
  ink: string;
  tickets: Ticket[];
}

const BUCKETS: { key: TicketGroup['key']; label: string; dot: string; ink: string; test: (t: Ticket) => boolean }[] = [
  { key: 'overdue', label: 'Overdue', dot: colors.danger, ink: colors.dangerInk, test: (t) => isOpen(t) && dueInfo(t).late },
  { key: 'today', label: 'Today', dot: colors.amber, ink: colors.ink, test: (t) => isOpen(t) && dueInfo(t).days === 0 },
  {
    key: 'week',
    label: 'This week',
    dot: colors.primary,
    ink: colors.ink,
    test: (t) => {
      const d = dueInfo(t).days;
      return isOpen(t) && d !== null && d > 0 && d <= 6;
    },
  },
  {
    key: 'later',
    label: 'Later',
    dot: colors.faint,
    ink: colors.ink,
    test: (t) => {
      const d = dueInfo(t).days;
      return isOpen(t) && (d === null || d > 6);
    },
  },
  { key: 'done', label: 'Done', dot: colors.green, ink: colors.ink, test: (t) => !isOpen(t) },
];

/** Filter counts for the segmented control ("Open 6 / Done 1 / All 7"). */
export function ticketFilterCounts(s: AppState): Record<TicketFilter, number> {
  const mine = myTickets(s);
  const open = mine.filter(isOpen).length;
  return { open, done: mine.length - open, all: mine.length };
}

/** My tickets for a filter, sorted by due date and bucketed (empty buckets dropped). */
export function ticketGroups(s: AppState, filter: TicketFilter): TicketGroup[] {
  const mine = myTickets(s);
  const list = filter === 'open' ? mine.filter(isOpen) : filter === 'done' ? mine.filter((t) => !isOpen(t)) : mine;
  const sorted = list.slice().sort(byDue);
  return BUCKETS.map((b) => ({ key: b.key, label: b.label, dot: b.dot, ink: b.ink, tickets: sorted.filter(b.test) })).filter(
    (g) => g.tickets.length,
  );
}

// ── Ticket board ────────────────────────────────────────────────────────────

/** Projects on the board: every project that has tickets, in ticket order. */
export function boardProjects(s: AppState): string[] {
  return [...new Set(s.tickets.map((t) => t.proj).filter(Boolean))];
}

export interface BoardState {
  projects: string[];
  project: string;
  epics: string[];
  epic: string;
  view: 'board' | 'list';
  tickets: Ticket[];
}

/** The board's current selection (project defaults to the first; unknown epic → all). */
export function boardState(s: AppState): BoardState {
  const projects = boardProjects(s);
  const project = s.ui.boardProject && projects.includes(s.ui.boardProject) ? s.ui.boardProject : (projects[0] ?? '');
  const pts = s.tickets.filter((t) => t.proj === project);
  const epics = [...new Set(pts.map((t) => t.epic))];
  const epic = s.ui.boardEpic !== 'all' && epics.includes(s.ui.boardEpic) ? s.ui.boardEpic : 'all';
  const tickets = pts.filter((t) => epic === 'all' || t.epic === epic);
  return { projects, project, epics, epic, view: s.ui.boardView, tickets };
}

export interface BoardColumn {
  st: TicketStatus;
  label: string;
  dot: string;
  tickets: Ticket[];
}

/** Four status columns (To do, In progress, Review, Done). */
export function boardColumns(tickets: Ticket[]): BoardColumn[] {
  return TICKET_STATUS_ORDER.map((st) => ({
    st,
    label: TICKET_STATUS[st].label,
    dot: TICKET_STATUS[st].dot,
    tickets: tickets.filter((t) => t.st === st),
  }));
}

/** List view: sections per "Epic · Sprint", in first-seen order. */
export function boardSprintGroups(tickets: Ticket[]): { label: string; tickets: Ticket[] }[] {
  const labels = [...new Set(tickets.map((t) => `${t.epic} · ${t.sprint}`))];
  return labels.map((label) => ({ label, tickets: tickets.filter((t) => `${t.epic} · ${t.sprint}` === label) }));
}

// ── Ticket detail ───────────────────────────────────────────────────────────

/** The last 4 of my time entries on a ticket, newest first ('*' demo entries are mine). */
export function myTicketLog(s: AppState, ticketId: number): (TimeEntry & { who: string })[] {
  const name = me(s)?.name ?? '';
  return s.entries
    .filter((e) => e.tk === ticketId && (e.who === name || e.who === ANY_USER))
    .slice(-4)
    .reverse()
    .map((e) => ({ ...e, who: e.who === ANY_USER ? name : e.who }));
}
