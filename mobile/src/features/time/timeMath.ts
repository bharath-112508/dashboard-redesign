/**
 * Pure time maths for S5-TIME, S5-EMP and S5-COTS (W3). Everything works on resolved
 * entries (`entriesAll` / `myEntries`), so the demo-owner entries ('*') are already the
 * signed-in person's.
 */
import { DAY_MIN, TODAY } from '@/data/clock';
import { addD, csv, dow, fmtL, hm, monday } from '@/data/format';
import type { TimeEntry } from '@/data/types';

export const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** History / team period chips. */
export type Period = 'week' | 'last' | 'month' | '30' | 'all';

/** Inclusive ISO range of a period (v5 `range`). */
export function periodRange(per: Period, today = TODAY): [string, string] {
  const w = monday(today);
  switch (per) {
    case 'last':
      return [addD(w, -7), addD(w, -1)];
    case 'month':
      return [`${today.slice(0, 7)}-01`, `${today.slice(0, 7)}-31`];
    case '30':
      return [addD(today, -30), today];
    case 'all':
      return ['2000-01-01', '2100-01-01'];
    default:
      return [w, addD(w, 6)];
  }
}

export const sum = (L: { min: number }[]): number => L.reduce((a, e) => a + e.min, 0);
export const billMin = (L: TimeEntry[]): number => sum(L.filter((e) => e.bill));
export const nonMin = (L: TimeEntry[]): number => sum(L.filter((e) => !e.bill));
export const inRange = (L: TimeEntry[], from: string, to: string): TimeEntry[] => L.filter((e) => e.date >= from && e.date <= to);

/** Weekend day (Sat/Sun). */
export const isWeekend = (iso: string): boolean => {
  const d = dow(iso);
  return d === 'Sat' || d === 'Sun';
};

export interface StripDay {
  date: string;
  day: string;
  num: string;
  hours: string;
  short: boolean;
  today: boolean;
}

/**
 * The Log day strip: Mon–Sun of the selected day's week. Hours show the logged time,
 * "0h" for an empty past weekday, nothing otherwise. Past weekdays under 8h are short
 * (not for freelancers).
 */
export function dayStrip(mine: TimeEntry[], day: string, free: boolean, today = TODAY): StripDay[] {
  const w = monday(day);
  return WD.map((name, i) => {
    const d = addD(w, i);
    const m = sum(mine.filter((e) => e.date === d));
    const we = i > 4;
    return {
      date: d,
      day: name,
      num: String(+d.slice(8)),
      hours: m ? hm(m) : we ? '' : d <= today ? '0h' : '',
      short: !we && !free && m < DAY_MIN && d <= today,
      today: d === today,
    };
  });
}

export interface DaySummary {
  label: string;
  value: string;
  of: string;
  sub: string;
  short: boolean;
}

/** The day KPI: "Sat 10 Oct · Today", logged, "/ 8h", and the idle / weekend line. */
export function daySummary(mine: TimeEntry[], day: string, free: boolean, today = TODAY): DaySummary {
  const tot = sum(mine.filter((e) => e.date === day));
  const need = free || isWeekend(day) ? 0 : DAY_MIN;
  return {
    label: fmtL(day) + (day === today ? ' · Today' : ''),
    value: hm(tot),
    of: need ? '/ 8h' : '',
    sub: need ? (tot >= need ? 'Day complete' : `${hm(need - tot)} idle`) : free ? 'Freelancer · no idle time' : 'Weekend',
    short: !!need && tot < need,
  };
}

export interface WeekSummary {
  days: string[];
  total: number;
  bill: number;
  non: number;
  /** idle minutes over Mon–Fri (0 for freelancers) */
  idle: number;
}

/** Week totals for the week starting `mon`. */
export function weekSummary(mine: TimeEntry[], mon: string, free: boolean): WeekSummary {
  const days = WD.map((_, i) => addD(mon, i));
  const L = inRange(mine, days[0], days[6]);
  const idle = free ? 0 : days.slice(0, 5).reduce((a, d) => a + Math.max(0, DAY_MIN - sum(L.filter((e) => e.date === d))), 0);
  return { days, total: sum(L), bill: billMin(L), non: nonMin(L), idle };
}

export interface HeatLine {
  title: string;
  sub: string;
  cells: number[];
}

/** Week overview rows: project + task (ticket key or text) × Mon–Sun minutes. */
export function heatRows(mine: TimeEntry[], mon: string, projLabel: (v: string) => string, keyLabel: (k: string) => string = (k) => k): HeatLine[] {
  const days = WD.map((_, i) => addD(mon, i));
  const L = inRange(mine, days[0], days[6]);
  const G = new Map<string, HeatLine>();
  for (const e of L) {
    const k = `${e.proj}|${e.key || e.task}`;
    let g = G.get(k);
    if (!g) {
      g = { title: e.key ? `${keyLabel(e.key)} · ${e.task}` : e.task, sub: projLabel(e.proj), cells: days.map(() => 0) };
      G.set(k, g);
    }
    g.cells[days.indexOf(e.date)] += e.min;
  }
  return [...G.values()];
}

export type GroupBy = 'day' | 'proj' | 'task';

export interface EntryGroup {
  key: string;
  total: number;
  entries: TimeEntry[];
}

/** Newest first, then by id. */
export const newestFirst = (L: TimeEntry[]): TimeEntry[] => [...L].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

/** History groups in first-seen order of the (newest-first) list. */
export function groupEntries(L: TimeEntry[], by: GroupBy): EntryGroup[] {
  const G = new Map<string, EntryGroup>();
  for (const e of newestFirst(L)) {
    const k = by === 'day' ? e.date : by === 'proj' ? e.proj : e.key || e.task;
    let g = G.get(k);
    if (!g) {
      g = { key: k, total: 0, entries: [] };
      G.set(k, g);
    }
    g.entries.push(e);
    g.total += e.min;
  }
  return [...G.values()];
}

/** Totals per key, largest first (By project / By employee bars). */
export function totalsBy(L: TimeEntry[], key: (e: TimeEntry) => string): { key: string; min: number }[] {
  const m = new Map<string, number>();
  for (const e of L) m.set(key(e), (m.get(key(e)) ?? 0) + e.min);
  return [...m.entries()].map(([k, min]) => ({ key: k, min })).sort((a, b) => b.min - a.min);
}

/** Project and employee filters ('all' = no filter). */
export function filterTeam(L: TimeEntry[], pf: string, ef: string): TimeEntry[] {
  return L.filter((e) => (pf === 'all' || e.proj === pf) && (ef === 'all' || e.who === ef));
}

/** File-name slug: "Bhavana P" → "bhavana-p". */
export const slug = (name: string): string => name.toLowerCase().trim().replace(/\s+/g, '-');

/** My timesheet CSV (columns Date, Project, Ticket, Task, Billable, Minutes, Note). */
export function myCsv(L: TimeEntry[], projLabel: (v: string) => string, keyLabel: (k: string) => string = (k) => k): string {
  return csv([
    ['Date', 'Project', 'Ticket', 'Task', 'Billable', 'Minutes', 'Note'],
    ...L.map((e) => [e.date, projLabel(e.proj), e.key ? keyLabel(e.key) : '', e.task, e.bill ? 'Yes' : 'No', e.min, e.note || '']),
  ]);
}

/** Employee / company timesheet CSV (columns Date, Employee, Project, Ticket, Task, Billable, Minutes). */
export function teamCsv(L: TimeEntry[], projLabel: (v: string) => string, keyLabel: (k: string) => string = (k) => k): string {
  return csv([
    ['Date', 'Employee', 'Project', 'Ticket', 'Task', 'Billable', 'Minutes'],
    ...L.map((e) => [e.date, e.who, projLabel(e.proj), e.key ? keyLabel(e.key) : '', e.task, e.bill ? 'Yes' : 'No', e.min]),
  ]);
}
