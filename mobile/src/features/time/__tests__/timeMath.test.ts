import { describe, expect, it } from '@jest/globals';

import { harness } from '@/data/__tests__/helpers';
import { entriesAll, myEntries, projLabel } from '@/data/selectors';
import type { TimeEntry } from '@/data/types';

import { logProjectOptions, logTicketOptions, normalizeKey } from '../logOptions';
import { dayStrip, daySummary, filterTeam, groupEntries, heatRows, myCsv, periodRange, slug, teamCsv, totalsBy, weekSummary } from '../timeMath';

const e = (id: number, date: string, min: number, bill = true, extra: Partial<TimeEntry> = {}): TimeEntry => ({
  id, who: 'Rahul', date, proj: 'c:dacop', key: '', task: 'Work', min, bill, note: '', ...extra,
});

describe('periods', () => {
  it('ranges from TODAY (Sat 10 Oct 2026)', () => {
    expect(periodRange('week')).toEqual(['2026-10-05', '2026-10-11']);
    expect(periodRange('last')).toEqual(['2026-09-28', '2026-10-04']);
    expect(periodRange('month')).toEqual(['2026-10-01', '2026-10-31']);
    expect(periodRange('30')).toEqual(['2026-09-10', '2026-10-10']);
  });
});

describe('day and week maths', () => {
  const L = [e(1, '2026-10-05', 480), e(2, '2026-10-06', 300, false), e(3, '2026-10-10', 60)];
  it('day strip: hours, 0h for empty past weekdays, short days', () => {
    const d = dayStrip(L, '2026-10-10', false);
    expect(d.map((x) => x.hours)).toEqual(['8h', '5h', '0h', '0h', '0h', '1h', '']);
    expect(d.map((x) => x.short)).toEqual([false, true, true, true, true, false, false]);
    expect(d[5].today).toBe(true);
    expect(dayStrip(L, '2026-10-10', true).some((x) => x.short)).toBe(false);
  });
  it('day KPI: idle, complete, weekend, freelancer', () => {
    expect(daySummary(L, '2026-10-06', false)).toMatchObject({ label: 'Tue 6 Oct', value: '5h', of: '/ 8h', sub: '3h idle', short: true });
    expect(daySummary(L, '2026-10-05', false)).toMatchObject({ sub: 'Day complete', short: false });
    expect(daySummary(L, '2026-10-10', false)).toMatchObject({ label: 'Sat 10 Oct · Today', of: '', sub: 'Weekend' });
    expect(daySummary(L, '2026-10-06', true)).toMatchObject({ of: '', sub: 'Freelancer · no idle time', short: false });
  });
  it('week totals and idle (none for freelancers)', () => {
    expect(weekSummary(L, '2026-10-05', false)).toMatchObject({ total: 840, bill: 540, non: 300, idle: 180 + 480 * 3 });
    expect(weekSummary(L, '2026-10-05', true).idle).toBe(0);
  });
  it('heat rows by project + task', () => {
    const H = heatRows([e(1, '2026-10-05', 60, true, { key: 'PMT-10', task: 'Login' }), e(2, '2026-10-07', 30, true, { key: 'PMT-10', task: 'Login' }), e(3, '2026-10-07', 45)], '2026-10-05', (v) => v);
    expect(H).toHaveLength(2);
    expect(H[0]).toMatchObject({ title: 'PMT-10 · Login', sub: 'c:dacop', cells: [60, 0, 30, 0, 0, 0, 0] });
  });
});

describe('history, team filters and CSV', () => {
  const L = [e(1, '2026-10-05', 60), e(2, '2026-10-06', 30, false, { proj: 'x:admin', task: 'Call', who: 'Vivek' }), e(3, '2026-10-06', 45, true, { key: 'PMT-10', task: 'Login' })];
  it('groups by day, project and task, newest first', () => {
    expect(groupEntries(L, 'day').map((g) => [g.key, g.total])).toEqual([['2026-10-06', 75], ['2026-10-05', 60]]);
    expect(groupEntries(L, 'proj').map((g) => g.key)).toEqual(['c:dacop', 'x:admin']);
    expect(groupEntries(L, 'task').map((g) => g.key)).toEqual(['PMT-10', 'Call', 'Work']);
  });
  it('filters and totals', () => {
    expect(filterTeam(L, 'x:admin', 'all').map((x) => x.id)).toEqual([2]);
    expect(filterTeam(L, 'all', 'Rahul').map((x) => x.id)).toEqual([1, 3]);
    expect(totalsBy(L, (x) => x.who)).toEqual([{ key: 'Rahul', min: 105 }, { key: 'Vivek', min: 30 }]);
  });
  it('CSV rows', () => {
    expect(myCsv([L[2]], (v) => `P ${v}`).split('\n')).toEqual(['Date,Project,Ticket,Task,Billable,Minutes,Note', '2026-10-06,P c:dacop,PMT-10,Login,Yes,45,']);
    expect(teamCsv([L[1]], () => 'Admin & meetings').split('\n')[1]).toBe('2026-10-06,Vivek,Admin & meetings,,Call,No,30');
    expect(slug('Bhavana P')).toBe('bhavana-p');
  });
});

describe('SH-LOG options (W3)', () => {
  it('project picker: client projects, internal, Admin & meetings', () => {
    const h = harness(1);
    const o = logProjectOptions(h.get());
    expect(o.client[0]).toMatchObject({ value: 'c:dacop', title: 'Daco platform', sub: 'Daco' });
    expect(o.internal.at(-1)).toMatchObject({ value: 'x:admin', title: 'Admin & meetings', sub: 'Non-billable' });
    expect(o.internal.every((x) => x.sub === 'Viljetech' || x.kind === 'admin')).toBe(true);
  });
  it('ticket picker: open tickets with subtasks keyed by stable id (A-11)', () => {
    const h = harness(1);
    const T = logTicketOptions(h.get(), 'c:dacop');
    const sub = T.find((x) => x.k === 'PMT-11.2');
    expect(sub).toMatchObject({ value: 'PMT-11.s2', title: expect.stringMatching(/^↳ /), sub: 'Subtask of PMT-11' });
    expect(logTicketOptions(h.get(), 'x:admin')).toEqual([]);
    expect(normalizeKey(h.get(), 'PMT-11.2')).toBe('PMT-11.s2');
    expect(normalizeKey(h.get(), 'PMT-10')).toBe('PMT-10');
  });
  it('a subtask entry is stored with its id and shows in my entries', () => {
    const h = harness(3);
    const r = h.cmd.saveTimeEntry({ proj: 'c:dacop', mode: 'ticket', key: 'PMT-11.s2', h: 1, bill: true });
    expect(r).toMatchObject({ ok: true, toast: '1h logged' });
    const mine = myEntries(h.get());
    expect(mine[0]).toMatchObject({ key: 'PMT-11.s2', who: 'Chary' });
    expect(projLabel(h.get(), mine[0].proj)).toBe('Daco · Daco platform');
    expect(entriesAll(h.get()).some((x) => x.who === '*')).toBe(false);
  });
});
