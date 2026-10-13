import { describe, expect, it } from '@jest/globals';

import { reducer } from '../store/reducer';
import { CLIENT_REFUSED } from '../store/clientPolicy';
import { harness } from './helpers';

// Product owner: "A client can only raise bugs and answer questions to them."
describe('client policy (commands)', () => {
  it('refuses every staff command for a client, with a clear error, and changes nothing', () => {
    const h = harness(8); // Lars Moen, cuser
    const before = h.get();
    const refused = [
      h.cmd.addTicketComment('PMT-11', 'Any news?'),
      h.cmd.patchTicket('PMT-11', { st: 'done' }),
      h.cmd.attachToTicket('PMT-11', { n: 'x.png', size: '1 KB' }),
      h.cmd.addSubtask('PMT-11', 'More'),
      h.cmd.commentOnSubtask('PMT-11', 'PMT-11.s1', 'Hi'),
      h.cmd.toggleSubtask('PMT-11', 'PMT-11.s2'),
      h.cmd.createTicket({ projectId: 'dacop', title: 'New' }),
      h.cmd.createQuestion({ projectId: 'dacop', title: 'Q', text: 'Why?' }),
      h.cmd.createDevopsRequest({ key: 'OPS-101', type: 'Access', prio: 'High', to: 'Arjun', text: 'Please' }),
      h.cmd.commentOnRequest(1, 'Hi'),
      h.cmd.addProjectFile('dacop', { n: 'spec.pdf', size: '2 MB' }),
      h.cmd.createSupportRequest({ projectId: 'dacop', kind: 'change', title: 'Change', desc: 'Please change' }),
    ];
    for (const r of refused) expect(r).toEqual({ ok: false, error: CLIENT_REFUSED, field: undefined });
    expect(h.cmd.saveTimeEntry({ proj: 'x:admin', mode: 'text', text: 'x', h: 1, bill: false })).toMatchObject({ ok: false, error: 'Your role does not log time' });
    expect(h.get()).toBe(before);
  });

  it('lets a client report bugs and problems, reply on their bugs and answer their questions', () => {
    const h = harness(7); // Ingrid Solberg, cadmin (Daco)
    expect(h.cmd.reportBug({ projectId: 'dacop', title: 'Broken', desc: 'It breaks' })).toMatchObject({ ok: true, toast: 'Bug reported. Thank you.' });
    expect(h.cmd.replyOnBug('cbm2', 'Still happens')).toMatchObject({ ok: true });
    expect(h.cmd.answerQuestion(4, 'Use the test environment')).toMatchObject({ ok: true, toast: 'Answer sent to the team' });
    expect(h.cmd.createSupportRequest({ projectId: 'dacop', kind: 'problem', title: 'Down', desc: 'Nothing loads' })).toMatchObject({ ok: true });
    expect(h.cmd.saveClientMember({ name: 'Ny Person', title: 'Tester', email: 'ny@daco.no' })).toMatchObject({ ok: true, toast: 'Invite sent' });
    expect(h.cmd.setBugStatus('cbm2', 'done')).toMatchObject({ ok: false, error: 'The team updates the status.' });
  });

  it("refuses work on another company's questions and projects", () => {
    const h = harness(7);
    expect(h.cmd.answerQuestion(7, 'Here you go')).toMatchObject({ ok: false, error: 'Question not found' }); // Nordlys
    expect(h.cmd.reportBug({ projectId: 'nordp', title: 'x', desc: 'y' })).toMatchObject({ ok: false, field: 'projectId' });
    expect(h.cmd.createSupportRequest({ projectId: 'fjp', kind: 'problem', title: 'x', desc: 'y' })).toMatchObject({ ok: false, error: CLIENT_REFUSED });
  });

  it('only a client admin manages the team', () => {
    const h = harness(8);
    expect(h.cmd.removeClientMember('ct2')).toMatchObject({ ok: false, error: 'Only client admins manage the team' });
    expect(h.get().clientTeam.map((m) => m.id)).toEqual(['ct1', 'ct2']);
  });

  it('staff keep their powers', () => {
    const h = harness(3);
    expect(h.cmd.addTicketComment('PMT-11', 'On it').ok).toBe(true);
    expect(h.cmd.createQuestion({ projectId: 'dacop', title: 'Q', text: 'Why?' })).toMatchObject({ ok: true, toast: 'Question sent to Daco' });
  });
});

describe('client policy (reducer)', () => {
  it('ignores a forged action dispatched while a client is signed in', () => {
    const s = harness(8).get();
    const forged = [
      reducer(s, { type: 'tickets/addComment', key: 'PMT-11', comment: { who: 'Lars Moen', t: 'forged', when: 'now' } }),
      reducer(s, { type: 'tickets/patch', key: 'PMT-11', patch: { st: 'done' } }),
      reducer(s, { type: 'questions/create', question: { id: 99, by: 'Lars Moen', title: 'x', text: 'y', when: 'now', task: null, answer: '', projectId: 'dacop' } }),
      reducer(s, { type: 'time/delete', id: 1 }),
      reducer(s, { type: 'users/setActive', id: 1, active: false }),
      reducer(s, { type: 'perms/toggle', role: 'dev', key: 'tickets.create' }),
      reducer(s, { type: 'profile/save', personId: 1, patch: { name: 'Hacked' } }),
      reducer(s, { type: 'tickets/create', ticket: { ...s.tickets[0], key: 'PMT-99', client: true, support: 'change' } }),
    ];
    for (const next of forged) expect(next).toBe(s);
  });

  it('applies the actions a client may take', () => {
    const s = harness(8).get();
    const next = reducer(s, { type: 'bugs/reply', id: 'cbm2', comment: { who: 'Lars Moen', t: 'More detail', when: 'now' } });
    expect(next).not.toBe(s);
    expect(reducer(s, { type: 'session/signOut' }).session.personId).toBeNull();
  });

  it('does not limit staff', () => {
    const s = harness(1).get();
    expect(reducer(s, { type: 'tickets/patch', key: 'PMT-11', patch: { st: 'done' } })).not.toBe(s);
  });
});
