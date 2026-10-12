import { describe, expect, it } from '@jest/globals';

import { harness } from '@/data/__tests__/helpers';
import type { Leave } from '@/data/types';

import { annualLeft, leaveDates, leaveDays, leaveKindLabel, leaveSub, splitLeave } from '../leave';

const l = (id: number, extra: Partial<Leave>): Leave => ({ id, who: 'Chary', kind: 'Annual', from: '2026-10-20', to: '2026-10-22', days: 3, reason: '', st: 'pending', ...extra });

describe('leave helpers', () => {
  it('days, dates and labels', () => {
    expect(leaveDays('2026-10-20', '2026-10-22')).toBe(3);
    expect(leaveDays('2026-10-08', '2026-10-08')).toBe(1);
    expect(leaveDates({ from: '2026-10-08', to: '2026-10-08' })).toBe('Thu 8 Oct');
    expect(leaveDates({ from: '2026-10-20', to: '2026-10-22' })).toBe('20 Oct – 22 Oct');
    expect(leaveKindLabel('Holiday')).toBe('Public holiday');
    expect(leaveSub(l(1, { reason: 'Family trip' }))).toBe('20 Oct – 22 Oct · 3 days · Family trip');
    expect(leaveSub(l(1, { days: 1, from: '2026-10-08', to: '2026-10-08' }))).toBe('Thu 8 Oct · 1 day');
  });
  it('annual balance: 25 minus approved annual days only', () => {
    const L = [l(1, { st: 'approved', days: 2 }), l(2, { st: 'pending' }), l(3, { st: 'approved', kind: 'Sick', days: 4 }), l(4, { who: 'Vivek', st: 'approved' })];
    expect(annualLeft(L, 'Chary')).toBe(23);
    expect(annualLeft(L, 'Rahul')).toBe(25);
  });
  it('split keeps store order', () => {
    const { pending, decided } = splitLeave([l(9, {}), l(1, { st: 'approved' }), l(2, {})]);
    expect(pending.map((x) => x.id)).toEqual([9, 2]);
    expect(decided.map((x) => x.id)).toEqual([1]);
  });
  it('approvers add approved leave; others send pending requests; seed balance', () => {
    const h = harness(2);
    expect(h.cmd.addLeave({ who: 'Sofia', kind: 'Sick', from: '2026-10-14', to: '2026-10-13' })).toMatchObject({ ok: false, error: 'End date is before start date' });
    expect(h.cmd.addLeave({ who: 'Sofia', kind: 'Annual', from: '2026-10-14', to: '2026-10-15' })).toMatchObject({ ok: true, toast: 'Leave added' });
    expect(annualLeft(h.get().leaves, 'Sofia')).toBe(23);
    h.as(3);
    expect(h.cmd.addLeave({ who: 'Sofia', kind: 'Annual', from: '2026-12-21', to: '2026-12-23' })).toMatchObject({ ok: true, toast: 'Request sent for approval' });
    expect(h.get().leaves[0]).toMatchObject({ who: 'Chary', st: 'pending', days: 3 });
    expect(annualLeft(h.get().leaves, 'Chary')).toBe(23);
  });
});
