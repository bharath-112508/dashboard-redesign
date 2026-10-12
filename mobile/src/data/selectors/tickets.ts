import { TODAY } from '../clock';
import { diff, fmt, fmtL } from '../format';
import type { AppState } from '../store/state';
import type { Subtask, Ticket, TicketPrio, TicketStatus } from '../types';
import { entriesAll } from './time';
import { me } from './session';

export function ticket(s: AppState, key: string | null | undefined): Ticket | null {
  return (key && s.tickets.find((t) => t.key === key)) || null;
}

/** A subtask with its parent, position and displayed key (A-11). */
export interface SubView extends Subtask {
  parent: Ticket;
  /** 0-based position */
  index: number;
  /** positional display key "PMT-11.2" */
  key: string;
  /** effective priority (falls back to the ticket's) */
  prio: TicketPrio;
  done: boolean;
}

function subView(t: Ticket, i: number): SubView {
  const x = t.subs[i];
  return { ...x, parent: t, index: i, key: `${t.key}.${i + 1}`, prio: x.prio ?? t.prio, done: x.st === 'done' };
}

/** Displayed key of a subtask ("PMT-11.2"). */
export function subKey(t: Ticket, subId: string): string {
  const i = t.subs.findIndex((x) => x.id === subId);
  return i < 0 ? subId : `${t.key}.${i + 1}`;
}

/**
 * A subtask by its stable id ("PMT-11.s2") or by its positional key ("PMT-11.2").
 * Links and time entries use the id (A-11).
 */
export function subOf(s: AppState, ref: string | null | undefined): SubView | null {
  if (!ref) return null;
  const byId = /^(.+)\.s\d+$/.exec(ref);
  if (byId) {
    const t = ticket(s, byId[1]);
    const i = t ? t.subs.findIndex((x) => x.id === ref) : -1;
    return t && i >= 0 ? subView(t, i) : null;
  }
  const pos = /^(.+)\.(\d+)$/.exec(ref);
  if (pos) {
    const t = ticket(s, pos[1]);
    const i = +pos[2] - 1;
    return t && t.subs[i] ? subView(t, i) : null;
  }
  return null;
}

/** A ticket or a subtask by key/id (`tkOrSub`): what a time entry's `key` points at. */
export function tkOrSub(
  s: AppState,
  ref: string | null | undefined,
): { key: string; title: string; sub: boolean; ticket: Ticket; subtask?: SubView } | null {
  const sub = subOf(s, ref);
  if (sub) return { key: sub.key, title: sub.title, sub: true, ticket: sub.parent, subtask: sub };
  const t = ticket(s, ref);
  return t ? { key: t.key, title: t.title, sub: false, ticket: t } : null;
}

/**
 * Minutes logged against a ticket key or subtask id (`loggedMin`). For a ticket key it
 * includes the time logged on its subtasks.
 */
export function loggedMin(s: AppState, ref: string): number {
  const t = ticket(s, ref);
  const keys = new Set([ref, ...(t ? t.subs.map((x) => x.id) : [])]);
  return entriesAll(s)
    .filter((e) => e.key && keys.has(e.key))
    .reduce((a, e) => a + e.min, 0);
}

export interface DueInfo {
  text: string;
  /** colour token value */
  color: string;
  late: boolean;
}

/**
 * Due text (`dueInfo`): "No date", the date when done, "Nd late" (red, bold), "Today"
 * (amber ink), "Tomorrow", otherwise "Sat 10 Oct".
 */
export function dueInfo(t: { due?: string; st: TicketStatus }): DueInfo {
  if (!t.due) return { text: 'No date', color: '#3B4A5E', late: false };
  if (t.st === 'done') return { text: fmt(t.due), color: '#3B4A5E', late: false };
  const d = diff(t.due, TODAY);
  if (d < 0) return { text: `${-d}d late`, color: '#C0392B', late: true };
  if (d === 0) return { text: 'Today', color: '#7A5C0E', late: false };
  if (d === 1) return { text: 'Tomorrow', color: '#1B2D45', late: false };
  return { text: fmtL(t.due), color: '#1B2D45', late: false };
}

/** Overdue: not done and due before TODAY. */
export const isLate = (t: { due?: string; st: TicketStatus }): boolean => !!t.due && t.st !== 'done' && t.due < TODAY;

/** Tickets assigned to the signed-in person. */
export function myTickets(s: AppState): Ticket[] {
  const name = me(s)?.name;
  return name ? s.tickets.filter((t) => t.as.includes(name)) : [];
}

/** Tickets tab badge: unread over my tickets (staff only). */
export function unreadTotal(s: AppState): number {
  return myTickets(s).reduce((a, t) => a + (t.unread || 0), 0);
}

/** Subtasks done / total. */
export function subProgress(t: Ticket): { done: number; total: number } {
  return { done: t.subs.filter((x) => x.st === 'done').length, total: t.subs.length };
}

/** Next ticket key for a project prefix (A-13): PREFIX-(max+1). */
export function nextTicketKey(s: AppState, prefix: string): string {
  const n = Math.max(0, ...s.tickets.filter((t) => t.key.startsWith(`${prefix}-`)).map((t) => Number(t.key.slice(prefix.length + 1)) || 0));
  return `${prefix}-${n + 1}`;
}
