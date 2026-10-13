/** Pure leave helpers (W3): labels, dates, balances. */
import { ANNUAL_LEAVE_DAYS, LEAVE_KINDS } from '@/data/constants';
import { diff, fmt, fmtL } from '@/data/format';
import type { Leave, LeaveKind, LeaveSt } from '@/data/types';
import type { ToneName } from '@/theme';

/** "Annual leave" for 'Annual'. */
export const leaveKindLabel = (k: LeaveKind): string => LEAVE_KINDS.find((x) => x.kind === k)?.label ?? k;

/** "Sat 10 Oct" for one day, "20 Oct – 22 Oct" otherwise. */
export const leaveDates = (l: Pick<Leave, 'from' | 'to'>): string => (l.from === l.to ? fmtL(l.from) : `${fmt(l.from)} – ${fmt(l.to)}`);

/** Days of a request: To − From + 1. */
export const leaveDays = (from: string, to: string): number => diff(to, from) + 1;

export const LEAVE_STATUS: Record<LeaveSt, { label: string; tone: ToneName }> = {
  pending: { label: 'Pending', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

/** Row sub: "20 Oct – 22 Oct · 3 days · Family trip". */
export function leaveSub(l: Leave): string {
  return `${leaveDates(l)} · ${l.days} day${l.days > 1 ? 's' : ''}${l.reason ? ` · ${l.reason}` : ''}`;
}

/** Annual leave left: 25 minus approved annual days (only Annual counts against the allowance). */
export function annualLeft(leaves: Leave[], who: string): number {
  return ANNUAL_LEAVE_DAYS - leaves.filter((l) => l.who === who && l.kind === 'Annual' && l.st === 'approved').reduce((a, l) => a + l.days, 0);
}

/** Pending and decided requests, in store order (newest added first, as v5). */
export function splitLeave(leaves: Leave[]): { pending: Leave[]; decided: Leave[] } {
  return { pending: leaves.filter((l) => l.st === 'pending'), decided: leaves.filter((l) => l.st !== 'pending') };
}
