import { teamWeek, type TeamRow } from '@/data/selectors';
import type { AppState } from '@/data/store/state';

export interface TeamView {
  rows: TeamRow[];
  totals: { logged: number; billable: number; idle: number };
}

/**
 * Team hours rows and totals for a week. Reads `teamWeek`, the same source as the Home
 * "Team hours" card, so both agree (DECISIONS.md 8). Freelancers count 0 idle.
 */
export function teamRows(s: AppState, offset: number): TeamView {
  const rows = teamWeek(s, offset);
  const sum = (f: (r: TeamRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    rows,
    totals: { logged: sum((r) => r.logged), billable: sum((r) => r.billable), idle: sum((r) => r.idle ?? 0) },
  };
}

/** Bar widths in % of the person's target (40h; freelancers are scaled on 40h too). */
export function barWidths(r: TeamRow): { logged: number; billable: number } {
  const scale = r.target || 40;
  return { logged: Math.min(100, (r.logged / scale) * 100), billable: Math.min(100, (r.billable / scale) * 100) };
}
