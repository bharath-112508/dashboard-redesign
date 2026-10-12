import { TODAY, WEEK_MONDAY, WEEK_TARGET_HOURS } from '../clock';
import { addD, sh, weekday } from '../format';
import { TEAM_WEEK_BASE } from '../seed/work';
import type { AppState } from '../store/state';
import { ANY_USER, type TimeEntry } from '../types';
import { me, staffPeople } from './session';

export interface DayData {
  d: string;
  entries: TimeEntry[];
  /** billable hours */
  bill: number;
  /** non-billable hours */
  non: number;
  /** idle hours: 8 − logged on past weekdays (never for freelancers) */
  idle: number;
  isWeekday: boolean;
  /** on or before TODAY (can log time) */
  past: boolean;
  isToday: boolean;
}

export interface WeekRange {
  mon: string;
  sun: string;
  /** "5 Oct – 11 Oct" */
  label: string;
  /** "This week" / "Last week" / "3 weeks ago" */
  rel: string;
}

export function weekRange(offset: number): WeekRange {
  const mon = addD(WEEK_MONDAY, 7 * offset);
  const sun = addD(mon, 6);
  const rel = offset === 0 ? 'This week' : offset === -1 ? 'Last week' : `${-offset} weeks ago`;
  return { mon, sun, label: `${sh(mon)} – ${sh(sun)}`, rel };
}

/** Generated demo entries for past weeks (SPEC S-TIME; DECISIONS.md 6). */
function generatedWeek(offset: number, mon: string): TimeEntry[] {
  if (offset >= 0) return [];
  return [0, 1, 2, 3, 4].flatMap((i) => [
    { id: `g${offset}${i}`, d: addD(mon, i), tk: 8, text: '', h: 6, bill: true, note: 'Sprint work', who: ANY_USER },
    { id: `h${offset}${i}`, d: addD(mon, i), tk: null, text: 'Standup & reviews', h: 1.5, bill: false, note: '', who: ANY_USER },
  ]);
}

/** The signed-in person's entries (their own plus the demo '*' entries). */
export function myEntries(s: AppState): TimeEntry[] {
  const name = me(s)?.name;
  return s.entries.filter((e) => e.who === ANY_USER || e.who === name);
}

/** Seven days of the signed-in person's week at `offset` (prototype weekData). */
export function weekData(s: AppState, offset: number): DayData[] {
  const person = me(s);
  const free = person?.role === 'free';
  const { mon, sun } = weekRange(offset);
  const mine = myEntries(s).filter((e) => e.d >= mon && e.d <= sun);
  const all = [...generatedWeek(offset, mon), ...mine];
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = addD(mon, i);
    const entries = all.filter((e) => e.d === d);
    const bill = entries.filter((e) => e.bill).reduce((a, e) => a + e.h, 0);
    const non = entries.filter((e) => !e.bill).reduce((a, e) => a + e.h, 0);
    const wd = weekday(d);
    const isWeekday = wd >= 1 && wd <= 5;
    const past = d <= TODAY;
    return {
      d, entries, bill, non,
      idle: !free && isWeekday && past ? Math.max(0, 8 - bill - non) : 0,
      isWeekday, past, isToday: d === TODAY,
    };
  });
}

export interface WeekTotals {
  bill: number;
  non: number;
  idle: number;
  total: number;
}

export function weekTotals(days: DayData[]): WeekTotals {
  const bill = days.reduce((a, d) => a + d.bill, 0);
  const non = days.reduce((a, d) => a + d.non, 0);
  const idle = days.reduce((a, d) => a + d.idle, 0);
  return { bill, non, idle, total: bill + non };
}

export interface TeamRow {
  name: string;
  /** "Developer", "Freelancer", … (first part of the title) */
  roleLabel: string;
  isFree: boolean;
  logged: number;
  billable: number;
  nonBillable: number;
  /** null for freelancers (no target) */
  idle: number | null;
  /** 0 for freelancers */
  target: number;
}

/**
 * Team hours for a week (single source for Home "Team hours" and the Team hours screen,
 * DECISIONS.md 8): the seeded weekly base per person (earlier weeks scaled by the
 * prototype's demo factor) plus the hours that person logged in the app that week.
 */
export function teamWeek(s: AppState, offset: number): TeamRow[] {
  const { mon, sun } = weekRange(offset);
  return staffPeople(s).map((p) => {
    const base = TEAM_WEEK_BASE[p.name] ?? [0, 0];
    const scale = offset === 0 ? 1 : 0.9 + ((p.name.length + offset * 3) % 3) * 0.05;
    const own = s.entries.filter((e) => e.who === p.name && e.d >= mon && e.d <= sun);
    const ownBill = own.filter((e) => e.bill).reduce((a, e) => a + e.h, 0);
    const ownAll = own.reduce((a, e) => a + e.h, 0);
    const logged = +(base[0] * scale).toFixed(1) + ownAll;
    const billable = +(base[1] * scale).toFixed(1) + ownBill;
    const isFree = p.role === 'free';
    const target = isFree ? 0 : WEEK_TARGET_HOURS;
    return {
      name: p.name,
      roleLabel: p.title.split(' · ')[0],
      isFree,
      logged,
      billable,
      nonBillable: Math.max(0, logged - billable),
      idle: isFree ? null : Math.max(0, target - logged),
      target,
    };
  });
}
