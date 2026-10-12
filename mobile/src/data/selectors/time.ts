import { DAY_MIN } from '../clock';
import { addD, DOW } from '../format';
import { ANY_USER } from '../seed/time';
import type { AppState } from '../store/state';
import type { TimeEntry } from '../types';
import { me } from './session';

/**
 * Every entry with its owner resolved (`ents()`): the demo-owner entries ('*') belong to
 * the signed-in person; generated team entries of the signed-in person are hidden (v5
 * shows `mine` for me and `team` for everyone else).
 */
export function entriesAll(s: AppState): TimeEntry[] {
  const name = me(s)?.name ?? '';
  const out: TimeEntry[] = [];
  for (const e of s.entries) {
    if (e.who === ANY_USER) out.push({ ...e, who: name });
    else if (e.team && e.who === name) continue;
    else out.push(e);
  }
  return out;
}

/** The signed-in person's entries, newest first. */
export function myEntries(s: AppState): TimeEntry[] {
  const name = me(s)?.name ?? '';
  return entriesAll(s)
    .filter((e) => e.who === name)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

/** Entries of one person (`who`) or everyone (null) between two ISO days, inclusive. */
export function entriesBetween(s: AppState, from: string, to: string, who: string | null = null): TimeEntry[] {
  return entriesAll(s).filter((e) => e.date >= from && e.date <= to && (who == null || e.who === who));
}

export interface DayBar {
  date: string;
  /** "Mon" */
  day: string;
  billMin: number;
  nonMin: number;
  /** required minutes not logged (weekdays, staff); 0 for freelancers and weekends */
  idleMin: number;
}

/**
 * Week bars (`weekBars`) for Mon–Sun of the week starting `mondayIso`: billable,
 * non-billable and idle minutes per day. `who` null = every person (team view).
 */
export function weekBars(s: AppState, mondayIso: string, who: string | null, opts: { idle?: boolean; people?: number } = {}): DayBar[] {
  const idle = opts.idle ?? true;
  const need = DAY_MIN * (opts.people ?? 1);
  const L = entriesBetween(s, mondayIso, addD(mondayIso, 6), who);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addD(mondayIso, i);
    const day = L.filter((e) => e.date === date);
    const billMin = day.filter((e) => e.bill).reduce((a, e) => a + e.min, 0);
    const nonMin = day.filter((e) => !e.bill).reduce((a, e) => a + e.min, 0);
    const idleMin = idle && i < 5 ? Math.max(0, need - billMin - nonMin) : 0;
    return { date, day: DOW[(i + 1) % 7], billMin, nonMin, idleMin };
  });
}

/** Total minutes of a list of entries. */
export const sumMin = (L: { min: number }[]): number => L.reduce((a, e) => a + e.min, 0);
