import { TODAY } from '@/data/clock';
import { dow, sh } from '@/data/format';
import { capabilities, me, myTickets, weekData } from '@/data/selectors';
import type { AppState } from '@/data/store/state';
import type { Ticket } from '@/data/types';

/** Project value for admin and meetings (no ticket, non-billable by default). */
export const INTERNAL = 'Internal';

/** Tickets the signed-in person can log time on (staffAll: every ticket; others: mine). */
function logPool(s: AppState): Ticket[] {
  const person = me(s);
  if (!person?.role) return [];
  return capabilities(person.role).staffAll ? s.tickets.filter((t) => t.proj !== '') : myTickets(s);
}

/**
 * Log sheet project choices (prototype `lp`): projects of my tickets, then active and
 * maintenance projects I am assigned to (staffAll: all of them). Internal is added by the sheet.
 */
export function logTimeProjectOptions(s: AppState): string[] {
  const person = me(s);
  if (!person?.role) return [];
  const staffAll = capabilities(person.role).staffAll;
  const pool = logPool(s);
  const out = new Set(pool.map((t) => t.proj));
  for (const p of s.projects) {
    if (p.status !== 'active' && p.status !== 'maint') continue;
    const m = s.maintenance[p.name];
    const assigned = !!m && (m.req.some((r) => r.as === person.name) || m.tasks.some((t) => t.who === person.name));
    if (staffAll || pool.some((t) => t.proj === p.name) || assigned) out.add(p.name);
  }
  return [...out];
}

/** Open tickets of a project to log on (the preset ticket stays even when done). */
export function logTimeTicketOptions(s: AppState, project: string, keepId?: number | null): Ticket[] {
  if (!project) return [];
  return logPool(s).filter((t) => t.proj === project && (t.st !== 'done' || t.id === keepId));
}

/** "Today, Sat 10 Oct · logged as Chary" */
export function logDayLabel(day: string, name: string): string {
  return `${day === TODAY ? 'Today, ' : ''}${dow(day)} ${sh(day)} · logged as ${name}`;
}

export interface HistoryRow {
  id: string;
  d: string;
  /** "Fri 9 Oct" */
  day: string;
  /** "PMT-11 · Push notifications…" or the free text */
  work: string;
  project: string;
  h: number;
  bill: boolean;
}

/** The signed-in person's entries over the last 4 weeks (prototype history rows). */
export function historyRows(s: AppState): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let o = -3; o <= 0; o++) {
    for (const d of weekData(s, o)) {
      for (const e of d.entries) {
        const t = e.tk != null ? s.tickets.find((x) => x.id === e.tk) : undefined;
        rows.push({
          id: `${o}-${String(e.id)}`,
          d: d.d,
          day: `${dow(d.d)} ${sh(d.d)}`,
          work: t ? `${t.key} · ${t.title}` : e.text,
          project: t ? t.proj : e.proj || INTERNAL,
          h: e.h,
          bill: e.bill,
        });
      }
    }
  }
  return rows;
}

export type HistoryFilter = 'all' | 'bill' | 'non';

export interface HistoryDay {
  d: string;
  day: string;
  total: number;
  rows: HistoryRow[];
}

export interface HistoryView {
  /** "all" plus each project, in first-seen order */
  projects: string[];
  rows: HistoryRow[];
  days: HistoryDay[];
  total: number;
}

/** Filtered history, newest day first; within a day the latest logged entry first. */
export function historyView(all: HistoryRow[], filter: HistoryFilter, project: string): HistoryView {
  const projects = ['all', ...new Set(all.map((r) => r.project))];
  const rows = all
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (filter === 'all' || (filter === 'bill') === r.bill) && (project === 'all' || r.project === project))
    .sort((a, b) => (a.r.d === b.r.d ? b.i - a.i : a.r.d < b.r.d ? 1 : -1))
    .map(({ r }) => r);
  const days: HistoryDay[] = [];
  for (const r of rows) {
    const last = days[days.length - 1];
    if (last && last.d === r.d) {
      last.rows.push(r);
      last.total += r.h;
    } else days.push({ d: r.d, day: r.day, total: r.h, rows: [r] });
  }
  return { projects, rows, days, total: rows.reduce((a, r) => a + r.h, 0) };
}

/** CSV with the prototype's columns: Date,Work,Project,Hours,Type. */
export function historyCsv(rows: HistoryRow[]): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return (
    'Date,Work,Project,Hours,Type\n' +
    rows.map((r) => [r.d, q(r.work), r.project.includes(',') ? q(r.project) : r.project, r.h, r.bill ? 'Billable' : 'Non-bill'].join(',')).join('\n')
  );
}
