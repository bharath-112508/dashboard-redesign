import { describe, expect, it } from '@jest/globals';
import { PDEF } from '../constants';
import { dvDate, fmt, fmtL, hm } from '../format';
import { can, perm } from '../selectors/access';
import { openQuestions } from '../selectors/client';
import { devopsAll, devopsFor, devopsPickerProjects } from '../selectors/devops';
import { epicsOf, projOpts, projVis } from '../selectors/projects';
import { dueInfo, loggedMin, subOf, tkOrSub, unreadTotal } from '../selectors/tickets';
import { entriesAll } from '../selectors/time';
import { morePages } from '../../nav/morePages';
import { harness } from './helpers';

const ids = (L: { id: string }[]) => L.map((p) => p.id).sort();

describe('format', () => {
  it('hm, fmt, fmtL, dvDate', () => {
    expect(hm(90)).toBe('1h 30m');
    expect(hm(45)).toBe('45m');
    expect(hm(0)).toBe('0h');
    expect(fmt('2026-10-10')).toBe('10 Oct');
    expect(fmt('2027-08-30')).toBe('30 Aug 2027'); // another year than TODAY: with the year
    expect(fmt('2025-12-31')).toBe('31 Dec 2025');
    expect(fmtL('2026-10-10')).toBe('Sat 10 Oct');
    expect(dvDate('2026-10-12T07:00')).toBe('12 Oct 2026, 07:00');
    expect(dvDate('2026-11-30')).toBe('30 Nov 2026');
  });
});

describe('dueInfo', () => {
  it('no date, done, late, today, tomorrow, later', () => {
    expect(dueInfo({ st: 'todo' }).text).toBe('No date');
    expect(dueInfo({ st: 'done', due: '2026-10-01' }).text).toBe('1 Oct');
    expect(dueInfo({ st: 'prog', due: '2026-10-07' })).toMatchObject({ text: '3d late', late: true });
    expect(dueInfo({ st: 'todo', due: '2026-10-10' }).text).toBe('Today');
    expect(dueInfo({ st: 'todo', due: '2026-10-11' }).text).toBe('Tomorrow');
    expect(dueInfo({ st: 'todo', due: '2026-10-14' }).text).toBe('Wed 14 Oct');
  });
});

describe('can / perm', () => {
  it('page access follows the web ACC map', () => {
    expect(can('super', 'Users')).toBe(true);
    expect(can('pm', 'Employee Timesheets')).toBe(true);
    expect(can('dev', 'Users')).toBe(false);
    expect(can('dev', 'My Tickets')).toBe(true);
    expect(can('devops', 'Projects')).toBe(false);
    expect(can('cadmin', 'Users')).toBe(true);
    expect(can('cuser', 'Users')).toBe(false);
    expect(can(null, 'Dashboard')).toBe(false);
  });
  it('super always; matrix toggles; clients none', () => {
    expect(perm('super', 'users.manage', { ...PDEF, admin: {} })).toBe(true);
    expect(perm('pm', 'sprints.manage')).toBe(true);
    expect(perm('pm', 'sprints.manage', { ...PDEF, pm: { ...PDEF.pm, 'sprints.manage': false } })).toBe(false);
    expect(perm('dev', 'tickets.assign')).toBe(false);
    expect(perm('devops', 'devops.edit')).toBe(true);
    expect(perm('cadmin', 'tickets.create')).toBe(false);
  });
});

describe('projVis per role', () => {
  it('super sees all; dev own list + teams; cadmin company; cuser list; devops none', () => {
    const h = harness(1);
    expect(projVis(h.get()).length).toBe(16);
    h.as(3); // Chary: dacop, nordp + teams (welop, osbyw, i2)
    expect(ids(projVis(h.get()))).toEqual(['dacop', 'i2', 'nordp', 'osbyw', 'welop']);
    h.as(7); // Ingrid: Daco
    expect(ids(projVis(h.get()))).toEqual(['dacop']);
    h.as(8);
    expect(ids(projVis(h.get()))).toEqual(['dacop']);
    h.as(6);
    expect(projVis(h.get())).toEqual([]);
  });
});

describe('morePages per role', () => {
  it('matches SPEC §2.5 (+ leave for staff)', () => {
    const labels = (r: Parameters<typeof morePages>[0]) => morePages(r).map((p) => p.label);
    expect(labels('super')).toEqual(['Companies', 'DevOps board', 'Clients', 'Employee timesheets', 'Users', 'Leave']);
    expect(labels('pm')).toEqual(['Companies', 'Clients', 'Employee timesheets', 'Leave']);
    expect(labels('dev')).toEqual(['Companies', 'Leave']);
    expect(labels('devops')).toEqual(['Leave']);
    expect(labels('cadmin')).toEqual(['Your team']);
    expect(labels('cuser')).toEqual([]);
  });
});

describe('client, devops, time selectors', () => {
  it('openQuestions: all open for staff, visible for clients', () => {
    const h = harness(1);
    expect(openQuestions(h.get()).map((q) => q.id)).toEqual([1, 4, 7]);
    h.as(7);
    expect(openQuestions(h.get()).map((q) => q.id)).toEqual([1, 4]);
  });
  it('devopsAll takes the name and company from projectId (DECISIONS 3)', () => {
    const h = harness(1);
    const d = devopsAll(h.get()).find((x) => x.key === 'OPS-103')!;
    expect(d.name).toBe('Order portal');
    expect(d.company).toBe('Weland');
    expect(devopsFor(h.get(), 'arcf')?.key).toBe('OPS-106');
    expect(devopsFor(h.get(), 'arcf')?.openRequests).toBe(1);
    const picker = ids(devopsPickerProjects(h.get()));
    expect(picker).toEqual(['fjp', 'i1', 'i2', 'nordp']);
  });
  it('projOpts and epicsOf', () => {
    const h = harness(1);
    const o = projOpts(h.get());
    expect(o[0]).toEqual({ value: 'c:dacop', label: 'Daco · Daco platform' });
    expect(o.at(-1)).toEqual({ value: 'x:admin', label: 'Admin & meetings' });
    expect(o.some((x) => x.value === 'i:i3')).toBe(false);
    expect(epicsOf(h.get(), 'i1')).toEqual([expect.objectContaining({ id: 'i1', name: 'DevOps board' })]);
  });
  it('entries: demo owner is me; my team entries hidden', () => {
    const h = harness(3);
    const all = entriesAll(h.get());
    expect(all.filter((e) => e.who === 'Chary' && e.id < 1000).length).toBe(39);
    expect(all.some((e) => e.team && e.who === 'Chary')).toBe(false);
  });
  it('loggedMin includes subtask ids; subOf by id and positional key', () => {
    const h = harness(3);
    const before = loggedMin(h.get(), 'PMT-11');
    const r = h.cmd.saveTimeEntry({ proj: 'c:dacop', mode: 'ticket', key: 'PMT-11.2', h: 1, m: 0, bill: true });
    expect(r.ok).toBe(true);
    const e = h.get().entries[0];
    expect(e.key).toBe('PMT-11.s2');
    expect(loggedMin(h.get(), 'PMT-11.s2')).toBe(60);
    expect(loggedMin(h.get(), 'PMT-11')).toBe(before + 60);
    expect(subOf(h.get(), 'PMT-11.s2')?.key).toBe('PMT-11.2');
    expect(tkOrSub(h.get(), 'PMT-11.2')?.title).toBe('Android token refresh');
  });
  it('unread badge = unread over my tickets', () => {
    const h = harness(3);
    expect(unreadTotal(h.get())).toBe(3);
  });
});
