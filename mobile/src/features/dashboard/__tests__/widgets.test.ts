import { describe, expect, it } from '@jest/globals';

import { harness } from '../../../data/__tests__/helpers';
import { buildDashboard, dayRange, devopsSteps, sprintLeft, sprintOfPlan, weekdays } from '../widgets';

const dash = (personId: number) => {
  const h = harness(personId);
  return { h, d: buildDashboard(h.get())! };
};
const titles = (personId: number) => dash(personId).d.widgets.map((w) => w.title);
const labels = (personId: number) => dash(personId).d.kpis.map((k) => k.label);

describe('dashboard widget builders (S5-DASH, one config per role)', () => {
  it('KPI labels and widget titles per role', () => {
    expect(labels(1)).toEqual(['Active projects', 'Logged this month', 'Idle time', 'Critical open']);
    expect(titles(1)).toEqual(['Budget vs hours used', 'Epic progress', 'Team hours this week', 'DevOps status', 'Client questions waiting', 'Leave & attendance']);
    expect(labels(2)).toEqual(['Pending leave', 'Holiday & personal', 'Team idle this week', 'Overdue tickets']);
    expect(titles(2)).toEqual(['Approvals', 'Hours by employee', 'Overdue tickets', 'DevOps status', 'Team hours this week']);
    expect(labels(4)).toEqual(['Active sprint', 'Sprint done', 'Due this week', 'Questions waiting']);
    expect(titles(4)).toEqual(['Active sprints', 'Tickets due this week', 'Budget vs hours used', 'Client questions waiting', 'Team load']);
    expect(labels(3)).toEqual(['My open tickets', 'Due this week', 'Logged this week', 'Idle this week']);
    expect(titles(3)).toEqual(['My tickets', 'My week', 'My active projects', 'My sprint', 'Questions on my tickets']);
    expect(labels(6)).toEqual(['Open requests', 'Projects in setup', 'Due this week', 'Logged this week']);
    expect(titles(6)).toEqual(['Infra status', 'DevOps requests', 'Waiting for client', 'My week']);
    expect(labels(7)).toEqual(['Projects', 'Overall progress', 'Next delivery', 'Questions for you']);
    expect(titles(7)).toEqual(['Epic progress', 'Questions waiting for you', 'Bugs reported', 'Go-live readiness']);
    expect(labels(8)).toEqual(['Questions for you', 'My open bugs', 'Next delivery', 'Sprint progress']);
    expect(titles(8)).toEqual(['Questions waiting for you', 'My bugs', 'Current sprint', 'Recently delivered']);
  });

  it('freelancer: no idle, no 40h target', () => {
    const { d } = dash(5);
    expect(d.kpis.map((k) => k.label)).toEqual(['My open tickets', 'Due this week', 'Logged this week', 'Billable this week']);
    expect(d.kpis[2].of).toBeUndefined();
    const week = d.widgets.find((w) => w.id === 'my-week');
    expect(week && week.k === 'bars' && week.idle).toBe(false);
  });

  it('numbers are live: dev tickets, overdue, unread-free counts', () => {
    const { d, h } = dash(3);
    expect(d.kpis[0]).toMatchObject({ value: '6', sub: '3 in progress' });
    expect(d.kpis[1]).toMatchObject({ value: '6', sub: '2 overdue' });
    const tix = d.widgets.find((w) => w.k === 'tix');
    expect(tix && tix.k === 'tix' && tix.keys).toEqual(['PMT-11', 'PMT-20', 'NRD-4', 'PMT-12']);
    h.cmd.patchTicket('PMT-11', { st: 'done' });
    expect(buildDashboard(h.get())!.kpis[0].value).toBe('5');
  });

  it('super: critical open and DevOps rows titled with the project name', () => {
    const { d } = dash(1);
    expect(d.kpis[3]).toMatchObject({ value: '2', sub: '1 overdue' });
    const dv = d.widgets.find((w) => w.id === 'devops');
    expect(dv && dv.k === 'status' && dv.items[0]).toMatchObject({ title: 'Daco platform', status: 'Not started', go: { dvp: 'OPS-101' } });
    const leave = d.widgets.find((w) => w.id === 'leave');
    expect(leave && leave.k === 'list' && leave.items[0]).toMatchObject({ title: 'Chary · 3 days', sub: 'Annual leave · 20–22 Oct' });
  });

  it('admin: overdue tickets and approvals from the store', () => {
    const { d, h } = dash(2);
    expect(d.kpis[3]).toMatchObject({ value: '2', sub: 'Across 1 project' });
    expect(d.kpis[0].value).toBe('2');
    expect(d.kpis[1].value).toBe('2');
    const id = h.get().leaves.find((l) => l.st === 'pending')!.id;
    h.cmd.decideLeave(id, 'approved');
    expect(buildDashboard(h.get())!.kpis[0].value).toBe('1');
  });

  it('devops: open requests live; clients: questions and my bugs live', () => {
    const { d, h } = dash(6);
    expect(d.kpis[0].value).toBe(String(h.get().devopsRequests.filter((r) => r.status !== 'Done').length));
    const req = d.widgets.find((w) => w.id === 'requests');
    expect(req && req.k === 'list' && req.items.every((x) => !x.sub.includes(' · Daco · '))).toBe(true);
    expect(dash(7).d.kpis[3].value).toBe('2');
    const cu = dash(8).d;
    expect(cu.kpis[0].value).toBe('2');
    expect(cu.kpis[1].value).toBe('1');
  });

  it('pm: active sprint and due this week on the projects they are on', () => {
    const { d } = dash(4);
    expect(d.kpis[0]).toMatchObject({ value: '8 days', of: 'left', sub: 'Mobile app · Sprint 2' });
    expect(d.kpis[1]).toMatchObject({ value: '0%', sub: '0 of 4 tasks' });
  });

  it('helpers', () => {
    expect(weekdays('2026-10-05', '2026-10-11')).toHaveLength(5);
    expect(dayRange('2026-10-20', '2026-10-22')).toBe('20–22 Oct');
    expect(dayRange('2026-10-08', '2026-10-08')).toBe('8 Oct');
    expect(sprintLeft({ end: '2026-10-11' })).toBe('ends tomorrow');
    expect(sprintLeft({ end: '2026-10-18' })).toBe('8 days left');
    expect(sprintOfPlan('Sprint 2', 8)).toBe('Sprint 2 of 8');
    expect(sprintOfPlan('Sprint 3', 2)).toBe('Sprint 3');
    expect(devopsSteps({ infra: 'Client onboarding', cicd: false })).toEqual(['current', 'future', 'future', 'future']);
    expect(devopsSteps({ infra: 'Deployment Completed', cicd: true })).toEqual(['done', 'done', 'done', 'done']);
  });
});
