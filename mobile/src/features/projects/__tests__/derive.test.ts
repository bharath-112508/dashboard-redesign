import { describe, expect, it } from '@jest/globals';

import { harness } from '@/data/__tests__/helpers';
import { project, projVis } from '@/data/selectors';

import {
  boardTickets,
  deadlineMeta,
  filterProjects,
  ganttRange,
  initialTab,
  listTickets,
  nextSprintStart,
  overview,
  projectFiles,
  projectRowSub,
  projectSpans,
  projectTabs,
  stateChips,
  taskStart,
} from '../derive';

const keys = (L: { key: string }[]) => L.map((t) => t.key).sort();

describe('projects list', () => {
  const { get } = harness(1);
  const all = projVis(get());

  it('filters by search (name, company, area), kind and state', () => {
    expect(filterProjects(all, { q: 'nordlys', kind: 'all', st: 'all' }).map((p) => p.id)).toEqual(['nordp']);
    expect(filterProjects(all, { q: 'tooling', kind: 'all', st: 'all' }).map((p) => p.id)).toEqual(['i1']);
    expect(filterProjects(all, { q: '', kind: 'internal', st: 'all' }).every((p) => p.kind === 'internal')).toBe(true);
    expect(filterProjects(all, { q: '', kind: 'all', st: 'maint' }).map((p) => p.id)).toEqual(['fjp']);
  });

  it('chips count states and hide On hold when none', () => {
    const chips = stateChips(all);
    expect(chips.find((c) => c.value === 'all')?.count).toBe(all.length);
    expect(chips.some((c) => c.value === 'hold')).toBe(false);
    expect(chips.find((c) => c.value === 'maint')?.count).toBe(1);
  });

  it('row sub and deadline meta', () => {
    const s = get();
    expect(projectRowSub(project(s, 'fjp')!)).toBe('Fjordline Logistics · Support until 30 Aug');
    expect(projectRowSub(project(s, 'i1')!)).toBe('Internal · Platform & tooling');
    expect(deadlineMeta(project(s, 'nordp')!)).toEqual({ text: 'Deadline passed 8 Oct', late: true });
    expect(deadlineMeta(project(s, 'dacop')!)).toEqual({ text: 'Deadline 20 Dec', late: false });
    expect(deadlineMeta(project(s, 'fjp')!)).toBeNull();
    expect(deadlineMeta(project(s, 'trca')!)?.late).toBe(false); // done is never late
  });
});

describe('project tabs', () => {
  it('staff, client and maintenance tab sets', () => {
    expect(projectTabs({ state: 'active' }, false)).toEqual(['overview', 'board', 'list', 'sprints', 'timeline', 'files', 'time', 'team', 'devops', 'questions']);
    expect(projectTabs({ state: 'active' }, true)).toEqual(['overview', 'board', 'timeline', 'questions', 'bugs', 'files']);
    expect(projectTabs({ state: 'maint' }, false)[1]).toBe('support');
    expect(projectTabs({ state: 'maint' }, true)[1]).toBe('support');
  });

  it('default tab: Support for maintenance; unknown tabs fall back', () => {
    expect(initialTab({ state: 'maint' }, false)).toBe('support');
    expect(initialTab({ state: 'active' }, false)).toBe('overview');
    expect(initialTab({ state: 'active' }, false, 'board')).toBe('board');
    expect(initialTab({ state: 'active' }, true, 'list')).toBe('overview');
    expect(initialTab({ state: 'active' }, false, 'support')).toBe('overview');
  });
});

describe('overview derivations', () => {
  it('open, overdue, critical, needs attention', () => {
    const { get } = harness(1);
    const o = overview(get(), project(get(), 'dacop')!);
    expect(o.open).toBe(7);
    expect(o.done).toBe(3);
    expect(keys(o.late)).toEqual(['PMT-11', 'PMT-20']);
    expect(keys(o.critical)).toEqual(['PMT-11']);
    expect(keys(o.attention)).toEqual(['PMT-11', 'PMT-20']);
  });

  it('over estimate uses logged time against est (hours)', () => {
    const { get, cmd } = harness(1);
    const before = overview(get(), project(get(), 'nordp')!).over.map((x) => x.ticket.key);
    expect(before).not.toContain('NRD-9');
    const r = cmd.saveTimeEntry({ date: '2026-10-09', proj: 'c:nordp', mode: 'ticket', key: 'NRD-9', text: '', h: '5', m: '0', bill: true, note: '' } as never);
    expect(r.ok).toBe(true);
    const after = overview(get(), project(get(), 'nordp')!).over;
    expect(after.find((x) => x.ticket.key === 'NRD-9')?.min).toBeGreaterThanOrEqual(300);
  });

  it('missed sprints: past their end and not done', () => {
    const { get } = harness(1);
    const o = overview(get(), project(get(), 'dacop')!);
    expect(o.missed.map((x) => x.id)).toEqual([]); // w3 ends 11 Oct, after TODAY
    const { get: g2, cmd } = harness(1);
    cmd.createSprint('web', { start: '2026-09-01', weeks: 1 });
    expect(overview(g2(), project(g2(), 'dacop')!).missed.map((x) => x.epicName)).toEqual(['Web app']);
  });

  it('time per person is sorted and sums the project entries', () => {
    const { get } = harness(1);
    const o = overview(get(), project(get(), 'dacop')!);
    expect(o.byPerson.length).toBeGreaterThan(0);
    for (let i = 1; i < o.byPerson.length; i++) expect(o.byPerson[i - 1].min).toBeGreaterThanOrEqual(o.byPerson[i].min);
    expect(o.epics.find((e) => e.id === 'mob')?.caption).toBe('2 of 7 tasks done · Sprint 2 ends 18 Oct');
  });
});

describe('board and list filters', () => {
  const { get } = harness(1);

  it('active sprint: tickets in an active sprint, plus support tickets without a sprint', () => {
    const s = get();
    expect(keys(boardTickets(s, 'dacop', 'mob', 'active', false))).toEqual(['PMT-10', 'PMT-11', 'PMT-12', 'PMT-31']);
    expect(keys(boardTickets(s, 'fjp', 'all', 'active', false))).toEqual(['FJD-3', 'FJD-4']);
  });

  it('backlog and all; clients see every ticket of the epic', () => {
    const s = get();
    expect(keys(boardTickets(s, 'dacop', 'all', 'backlog', false))).toEqual(['PMT-16']);
    expect(boardTickets(s, 'dacop', 'all', 'all', false)).toHaveLength(10);
    expect(boardTickets(s, 'dacop', 'mob', 'backlog', true)).toHaveLength(7);
  });

  it('list chips and search', () => {
    const T = get().tickets.filter((t) => t.projectId === 'dacop');
    expect(keys(listTickets(T, 'late', ''))).toEqual(['PMT-11', 'PMT-20']);
    expect(listTickets(T, 'done', '')).toHaveLength(3);
    expect(keys(listTickets(T, 'all', 'bankid'))).toEqual(['PMT-10']);
    expect(keys(listTickets(T, 'all', 'pmt-2'))).toEqual(['PMT-20', 'PMT-21', 'PMT-22']);
  });
});

describe('gantt positioning', () => {
  it('pads the range by 2 days, 4 ticks, clamps positions', () => {
    const r = ganttRange([
      ['2026-10-01', '2026-10-11'],
      ['2026-10-05', '2026-10-21'],
    ])!;
    expect(r.ticks).toEqual(['29 Sep', '7 Oct', '15 Oct', '23 Oct']);
    expect(r.pos('2026-09-29')).toBe(0);
    expect(r.pos('2026-10-23')).toBe(100);
    expect(r.pos('2026-10-11')).toBe(50);
    expect(r.now).toBeCloseTo(((10 + 1) / 24) * 100);
    expect(r.pos('2025-01-01')).toBe(0);
    expect(ganttRange([])).toBeNull();
  });

  it('task bars start at start, or 3 days before due', () => {
    expect(taskStart({ start: '2026-10-05', due: '2026-10-07' })).toBe('2026-10-05');
    expect(taskStart({ due: '2026-10-07' })).toBe('2026-10-04');
    const { get } = harness(1);
    const sp = projectSpans(get(), 'dacop');
    expect(sp.sprints.map((x) => x.id)).toEqual(['m1', 'm2', 'm3', 'w3', 'w4']);
    expect(sp.tasks[0].key).toBe('PMT-15');
  });
});

describe('sprints, files and key prefix', () => {
  it('a new sprint starts the day after the last one', () => {
    const { get } = harness(1);
    expect(nextSprintStart(get(), 'mob')).toBe('2026-11-02');
    expect(nextSprintStart(get(), 'n2')).toBe('2026-10-11'); // no sprints: TODAY + 1
  });

  it('project files and ticket attachments', () => {
    const { get, cmd } = harness(1);
    expect(projectFiles(get(), 'dacop').map((f) => f.tk)).toEqual(['PMT-11', 'PMT-15', 'PMT-20']);
    cmd.addProjectFile('dacop', { n: 'brief.pdf', size: '3 KB' });
    expect(projectFiles(get(), 'dacop')[0]).toMatchObject({ n: 'brief.pdf', tk: '' });
  });

  it('new tickets and support requests use the project key prefix (internal i1 = INT)', () => {
    const { get, cmd } = harness(1);
    const r = cmd.createTicket({ projectId: 'i1', title: 'Pipeline badge' } as never);
    expect(r.ok && (r as { key: string }).key).toBe('INT-6');
    const q = cmd.createSupportRequest({ projectId: 'fjp', kind: 'change', title: 'X', desc: 'Y' });
    expect(q.ok && q.key).toBe('FJD-5');
    expect(get().tickets.find((t) => t.key === 'FJD-5')).toMatchObject({ support: 'change', client: true, type: 'Task', due: '2026-10-24', as: ['Vivek'] });
  });
});
