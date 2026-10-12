import { describe, expect, it } from '@jest/globals';

import { DEFAULT_DEVOPS_SETTINGS } from '@/data/constants';
import { devopsAll, devopsByKey } from '@/data/selectors';
import { harness } from '@/data/__tests__/helpers';

import { chipCounts, filterBoard, groupBoard, ladderState, nextInternalName, nextLadderStep, overdue, phaseOf, phaseTone, requestTone } from '../board';

const S = DEFAULT_DEVOPS_SETTINGS;

describe('DevOps board filters and grouping (V-90)', () => {
  const h = harness(1);
  const all = devopsAll(h.get());

  it('counts the chips over the whole board', () => {
    const c = chipCounts(all, 'Chary');
    expect(c.all).toBe(11);
    expect(c.late).toBe(2);
    expect(c.client).toBe(3);
    expect(c.cicd).toBe(4);
    expect(c.mine).toBe(2);
  });

  it('overdue comes from the flag or a reminder before TODAY', () => {
    expect(overdue({ overdue: false, reminder: '2026-10-09T07:00' })).toBe(true);
    expect(overdue({ overdue: false, reminder: '2026-10-10T07:00' })).toBe(false);
    expect(overdue({ overdue: true })).toBe(true);
    expect(overdue({ overdue: false })).toBe(false);
  });

  it('searches project name, key and company (never "Client · Project")', () => {
    expect(filterBoard(all, 'all', 'order portal', 'x').map((d) => d.key)).toEqual(['OPS-103']);
    expect(filterBoard(all, 'all', 'ops-110', 'x').map((d) => d.name)).toEqual(['Member portal']);
    expect(filterBoard(all, 'all', 'weland', 'x').map((d) => d.key)).toEqual(['OPS-103']);
    expect(filterBoard(all, 'mine', '', 'Chary').map((d) => d.key)).toEqual(['OPS-101', 'OPS-103']);
    expect(filterBoard(all, 'cicd', '', '').every((d) => d.cicd)).toBe(true);
  });

  it('groups by status phase, owner and dev phase', () => {
    const byPhase = groupBoard(all, 'phase');
    expect(byPhase.map((g) => g.name)).toEqual(['Planned', 'In progress', 'Maintenance', 'Completed']);
    expect(byPhase.map((g) => g.items.length)).toEqual([2, 6, 1, 2]);
    expect(phaseOf('Adding new services')).toBe('Maintenance');
    expect(phaseTone('Not started')).toBe('grey');
    const byOwner = groupBoard(all, 'owner');
    expect(byOwner.reduce((n, g) => n + g.items.length, 0)).toBe(11);
    expect(new Set(byOwner.map((g) => g.name)).size).toBe(byOwner.length);
    const byDev = groupBoard(all, 'dev');
    expect(byDev[byDev.length - 1].name).toBe('Not set');
    expect(byDev.find((g) => g.name === 'Production')?.items.map((d) => d.key).sort()).toEqual(['OPS-104', 'OPS-111']);
  });
});

describe('ladders', () => {
  it('client ladder step and next step', () => {
    const h = harness(1);
    const d = devopsByKey(h.get(), 'OPS-103')!;
    expect(ladderState(d, S)).toEqual({ client: true, ix: 4 });
    expect(nextLadderStep(d, S)).toBe('Escalate');
    expect(nextLadderStep({ from: 'Client', act: 'Escalate', step: 5 }, S)).toBe('');
    expect(ladderState({ from: 'Development team', act: 'Not required' }, S)).toEqual({ client: false, ix: -1 });
  });

  it('internal follow-up appends the next step (logFollowUp)', () => {
    const h = harness(6);
    const d = devopsByKey(h.get(), 'OPS-105')!;
    expect(nextInternalName(d, S)).toBe('Follow-up 2');
    const r = h.cmd.logFollowUp('OPS-105', { note: 'Asked again', reminder: '2026-10-20', nextName: 'Follow-up 2' });
    expect(r.ok).toBe(true);
    const after = devopsByKey(h.get(), 'OPS-105')!;
    expect(after.ifu?.map((x) => [x.name, !!x.done])).toEqual([
      ['Waiting for dev team', true],
      ['Follow-up 1', true],
      ['Follow-up 2', false],
    ]);
    expect(after.ifu?.[1].note).toBe('Asked again');
    expect(after.reminder).toBe('2026-10-20T07:00');
  });

  it('client follow-up advances the ladder; the rules make the note required', () => {
    const h = harness(6);
    expect(h.cmd.logFollowUp('OPS-102', { reminder: '2026-10-14' })).toMatchObject({ ok: false, field: 'note' });
    expect(h.cmd.logFollowUp('OPS-102', { note: 'Called', reminder: '2026-10-14' }).ok).toBe(true);
    expect(devopsByKey(h.get(), 'OPS-102')).toMatchObject({ step: 2, act: 'Reminder 2' });
  });
});

describe('requests and settings', () => {
  it('request numbering is REQ-(max+1) and the tone follows status and priority', () => {
    const h = harness(4);
    const r = h.cmd.createDevopsRequest({ key: 'OPS-101', type: 'Access', prio: 'High', to: 'Ganesh', text: 'VPN access' });
    expect(r).toMatchObject({ ok: true, rkey: 'REQ-16', toast: 'Request sent to DevOps' });
    expect(requestTone({ status: 'Done', prio: 'High' })).toBe('green');
    expect(requestTone({ status: 'Open', prio: 'Critical' })).toBe('red');
    expect(requestTone({ status: 'Open', prio: 'Medium' })).toBe('amber');
    expect(requestTone({ status: 'Open', prio: 'Low' })).toBe('grey');
  });

  it('renaming a status moves its projects; removing moves them to the first status', () => {
    const h = harness(6);
    const i = h.get().devopsSettings.statuses.indexOf('Client onboarding');
    expect(h.cmd.saveDevopsSettingsItem('statuses', i, 'Onboarding').ok).toBe(true);
    expect(devopsByKey(h.get(), 'OPS-103')?.infra).toBe('Onboarding');
    expect(h.cmd.removeDevopsSettingsItem('statuses', i).ok).toBe(true);
    expect(devopsByKey(h.get(), 'OPS-103')?.infra).toBe('Not started');
  });
});
