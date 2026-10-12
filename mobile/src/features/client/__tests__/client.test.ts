import { describe, expect, it } from '@jest/globals';

import { openQuestions, visibleBugs, visibleQuestions } from '@/data/selectors';
import { harness } from '@/data/__tests__/helpers';

import { bugStatusLabel, clientSummaries, filterBugs, filterQuestions } from '../client';

describe('client portal helpers', () => {
  it('question segments: waiting vs answered (V-65)', () => {
    const h = harness(7);
    const Q = visibleQuestions(h.get());
    expect(filterQuestions(Q, 'wait').map((q) => q.id)).toEqual([1, 4]);
    expect(filterQuestions(Q, 'done').map((q) => q.id)).toEqual([2]);
    expect(h.cmd.answerQuestion(1, 'English too')).toMatchObject({ ok: true, toast: 'Answer sent to the team' });
    expect(openQuestions(h.get()).length).toBe(1);
  });

  it('bugs are filtered by the visible projects (A-16) and by segment', () => {
    const h = harness(8);
    const B = visibleBugs(h.get());
    expect(B.length).toBe(3);
    expect(filterBugs(B, 'mine', 'Lars Moen').map((b) => b.id)).toEqual(['cbm2']);
    expect(filterBugs(B, 'done', 'Lars Moen').map((b) => b.id)).toEqual(['cbm3']);
    expect(bugStatusLabel('prog')).toBe('Being fixed');
  });

  it('a staff status change shows the client label', () => {
    const h = harness(1);
    expect(h.cmd.setBugStatus('cbm2', 'review').ok).toBe(true);
    const b = h.get().bugs.find((x) => x.id === 'cbm2')!;
    expect(bugStatusLabel(b.st)).toBe('Testing');
  });

  it('clients list: waiting questions, open bugs and contacts per company', () => {
    const h = harness(1);
    const L = clientSummaries(h.get());
    const daco = L.find((x) => x.company.id === 'daco')!;
    expect(daco).toMatchObject({ waiting: 2, openBugs: 2, projectNames: ['Daco platform'] });
    expect(L.find((x) => x.company.id === 'nord')?.waiting).toBe(1);
    expect(L.find((x) => x.company.id === 'hav')).toBeUndefined();
  });
});
