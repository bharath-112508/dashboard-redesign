import { describe, expect, it } from '@jest/globals';
import { ENTRIES, TICKETS } from '../seed';
import { harness } from './helpers';

describe('session', () => {
  it('sign-in rules (DECISIONS 7)', () => {
    const h = harness(null);
    expect(h.cmd.signIn('', 'demo')).toMatchObject({ ok: false, error: 'Enter your email.' });
    expect(h.cmd.signIn('x@y.z', 'demo')).toMatchObject({ ok: false, error: "We don't recognise that email." });
    expect(h.cmd.signIn('lars@daco.no', 'nope')).toMatchObject({ ok: false, error: 'That password is not right.' });
    expect(h.cmd.signIn('ola@havbruk.no', 'demo')).toMatchObject({ ok: false, field: 'email' });
    expect(h.cmd.signIn(' LARS@daco.no ', 'demo')).toMatchObject({ ok: true, personId: 8 });
    expect(h.get().session.personId).toBe(8);
  });
});

describe('time', () => {
  it('validation order and toast', () => {
    const h = harness(3);
    const base = { proj: '', mode: 'ticket' as const, bill: true };
    expect(h.cmd.saveTimeEntry(base)).toMatchObject({ ok: false, error: 'Pick a project first' });
    expect(h.cmd.saveTimeEntry({ ...base, proj: 'c:dacop' })).toMatchObject({ ok: false, error: 'Pick a ticket, or switch to text' });
    expect(h.cmd.saveTimeEntry({ ...base, proj: 'c:dacop', mode: 'text' })).toMatchObject({ ok: false, error: 'Describe what you worked on' });
    expect(h.cmd.saveTimeEntry({ ...base, proj: 'x:admin', mode: 'ticket', text: 'Call' })).toMatchObject({ ok: false, error: 'Add the time spent' });
    expect(h.cmd.saveTimeEntry({ ...base, proj: 'x:admin', mode: 'text', text: 'Call', h: 1, m: 30 })).toMatchObject({ ok: true, toast: '1h 30m logged' });
    h.as(7);
    expect(h.cmd.saveTimeEntry({ ...base, proj: 'x:admin', mode: 'text', text: 'x', h: 1 })).toMatchObject({ ok: false, error: 'Your role does not log time' });
  });
});

describe('tickets and sprints', () => {
  it('create uses the project prefix (A-13)', () => {
    const h = harness(1);
    expect(h.cmd.createTicket({ projectId: 'dacop', title: 'New' })).toMatchObject({ ok: true, key: 'PMT-32', toast: 'PMT-32 created' });
    expect(h.cmd.createTicket({ projectId: 'i1', title: 'Infra' })).toMatchObject({ key: 'INT-6' });
  });
  it('subtask ids stay stable after a delete (A-11)', () => {
    const h = harness(1);
    h.cmd.deleteSubtask('PMT-11', 'PMT-11.s1');
    const t = h.get().tickets.find((x) => x.key === 'PMT-11')!;
    expect(t.subs.map((s) => s.id)).toEqual(['PMT-11.s2', 'PMT-11.s3']);
    expect(h.cmd.addSubtask('PMT-11', 'More')).toMatchObject({ id: 'PMT-11.s4' });
    expect(h.cmd.toggleSubtask('PMT-11', 'PMT-11.s4')).toMatchObject({ toast: 'Completed PMT-11.3' });
  });
  it('complete sprint moves unfinished tickets to the backlog', () => {
    const h = harness(1);
    expect(h.cmd.completeSprint('m2')).toMatchObject({ ok: true, toast: 'Sprint 2 completed' });
    const L = h.get().tickets.filter((t) => ['PMT-11', 'PMT-10', 'PMT-12', 'PMT-31'].includes(t.key));
    expect(L.every((t) => t.sprintId === null)).toBe(true);
  });
  it('one active sprint per epic (A-12)', () => {
    const h = harness(1);
    expect(h.cmd.startSprint('m3')).toMatchObject({ ok: false, error: 'Complete Sprint 2 first' });
    h.cmd.completeSprint('m2');
    expect(h.cmd.startSprint('m3')).toMatchObject({ ok: true, toast: 'Sprint 3 started' });
  });
});

describe('devops', () => {
  it('status → Client onboarding starts the ladder; Deployment Completed sets deploy', () => {
    const h = harness(6);
    expect(h.cmd.setDevopsStatus('OPS-101', 'Client onboarding')).toMatchObject({ ok: true, toast: 'Status updated' });
    let d = h.get().devops.find((x) => x.key === 'OPS-101')!;
    expect(d).toMatchObject({ from: 'Client', act: 'Waiting for client', step: 0, updatedBy: 'Arjun' });
    expect(d.logs[0].text).toBe('Status changed from Not started to Client onboarding');
    h.cmd.setDevopsStatus('OPS-107', 'Deployment Completed');
    d = h.get().devops.find((x) => x.key === 'OPS-107')!;
    expect(d.deploy).toBe('Completed');
  });
  it('follow-up advances the client ladder and the internal steps', () => {
    const h = harness(6);
    expect(h.cmd.logFollowUp('OPS-102', {})).toMatchObject({ ok: false, field: 'note' });
    expect(h.cmd.logFollowUp('OPS-102', { note: 'Called', reminder: '2026-10-14' })).toMatchObject({ ok: true, toast: 'Follow-up logged' });
    expect(h.get().devops.find((x) => x.key === 'OPS-102')).toMatchObject({ step: 2, act: 'Reminder 2', reminder: '2026-10-14T07:00', overdue: false });
    h.cmd.logFollowUp('OPS-106', { note: 'Pinged', reminder: '2026-10-15' });
    const ifu = h.get().devops.find((x) => x.key === 'OPS-106')!.ifu!;
    expect(ifu).toEqual([
      { date: '2026-10-08', name: 'Waiting for dev team', done: true, note: 'Pinged' },
      { date: '2026-10-15', name: 'Follow-up 1' },
    ]);
  });
  it('settings rename and remove propagate to projects', () => {
    const h = harness(6);
    const i = h.get().devopsSettings.statuses.indexOf('Client onboarding');
    h.cmd.saveDevopsSettingsItem('statuses', i, 'Onboarding');
    expect(h.get().devops.filter((d) => d.infra === 'Onboarding').map((d) => d.key)).toEqual(['OPS-102', 'OPS-103', 'OPS-109']);
    h.cmd.removeDevopsSettingsItem('statuses', i);
    expect(h.get().devops.find((d) => d.key === 'OPS-102')!.infra).toBe('Not started');
    expect(h.get().devops.find((d) => d.key === 'OPS-102')!.logs[0].text).toBe('Status Onboarding was removed');
  });
  it('new DevOps project links a project without a record', () => {
    const h = harness(6);
    expect(h.cmd.createDevopsProject({ projectId: 'dacop', initDue: '2026-12-01' })).toMatchObject({ ok: false });
    expect(h.cmd.createDevopsProject({ projectId: 'nordp', initDue: '2026-12-01', infra: 'Client onboarding' })).toMatchObject({ ok: true, key: 'OPS-112' });
    expect(h.get().devops.at(-1)).toMatchObject({ projectId: 'nordp', step: 0, act: 'Waiting for client' });
  });
});

describe('people, leave, permissions', () => {
  it('leave: approver adds approved; others pending; decide', () => {
    const h = harness(2);
    expect(h.cmd.addLeave({ who: 'Chary', kind: 'Annual', from: '2026-11-02', to: '2026-11-03' })).toMatchObject({ toast: 'Leave added' });
    expect(h.get().leaves[0]).toMatchObject({ who: 'Chary', days: 2, st: 'approved' });
    expect(h.cmd.decideLeave(1, 'approved')).toMatchObject({ toast: 'Approved' });
    h.as(3);
    expect(h.cmd.addLeave({ kind: 'Sick', from: '2026-11-05', to: '2026-11-04' })).toMatchObject({ ok: false, error: 'End date is before start date' });
    expect(h.cmd.addLeave({ kind: 'Sick', from: '2026-11-05', to: '2026-11-05' })).toMatchObject({ toast: 'Request sent for approval' });
    expect(h.cmd.decideLeave(2, 'rejected')).toMatchObject({ ok: false });
  });
  it('permission toggle and user remove', () => {
    const h = harness(2);
    h.cmd.togglePermission('pm', 'projects.create');
    expect(h.get().perms.pm['projects.create']).toBe(false);
    expect(h.cmd.removeUser(1)).toMatchObject({ ok: false });
    expect(h.cmd.removeUser(10)).toMatchObject({ ok: true, toast: 'User removed' });
    expect(h.cmd.saveUser({ name: 'X', email: 'CHARY@viljetech.com', role: 'dev' })).toMatchObject({ ok: false, error: 'Someone already uses that email' });
  });
});

describe('seed integrity', () => {
  const h = harness(1);
  const s = h.get();
  it('every ticket links to a project, an epic and a sprint that exist', () => {
    const projects = new Set(s.projects.map((p) => p.id));
    const epics = new Set([...s.epics.map((e) => e.id), ...s.projects.map((p) => p.id)]);
    const sprints = new Set(s.sprints.map((x) => x.id));
    for (const t of TICKETS) {
      expect(projects.has(t.projectId)).toBe(true);
      expect(epics.has(t.epicId)).toBe(true);
      if (t.sprintId) expect(sprints.has(t.sprintId)).toBe(true);
    }
  });
  it('every DevOps record and request links to a project / record', () => {
    const projects = new Set(s.projects.map((p) => p.id));
    expect(s.devops.every((d) => projects.has(d.projectId))).toBe(true);
    expect(new Set(s.devops.map((d) => d.projectId)).size).toBe(s.devops.length);
    expect(s.devopsRequests.every((r) => s.devops.some((d) => d.key === r.key))).toBe(true);
  });
  it('ids are unique; entries reference known projects; prefixes unique', () => {
    const uniq = (L: unknown[]) => new Set(L).size === L.length;
    expect(uniq(s.people.map((p) => p.id))).toBe(true);
    expect(uniq(s.people.map((p) => p.email))).toBe(true);
    expect(uniq(s.projects.map((p) => p.id))).toBe(true);
    expect(uniq(s.projects.map((p) => p.keyPrefix))).toBe(true);
    expect(uniq(s.tickets.map((t) => t.key))).toBe(true);
    expect(uniq(ENTRIES.map((e) => e.id))).toBe(true);
    const projects = new Set(s.projects.map((p) => p.id));
    expect(ENTRIES.every((e) => e.proj === 'x:admin' || projects.has(e.proj.slice(2)))).toBe(true);
    expect(s.tickets.some((t) => t.key.startsWith('OPS-'))).toBe(false);
  });
});
