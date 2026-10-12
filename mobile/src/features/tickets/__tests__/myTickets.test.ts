import { describe, expect, it } from '@jest/globals';

import { harness } from '../../../data/__tests__/helpers';
import { myTickets } from '../../../data/selectors/tickets';
import { dueGroup, filterView, groupTickets, myEpics, mySprints, needsYouNow, sortTickets } from '../myTickets';

const keys = (L: { key: string }[]) => L.map((t) => t.key);

describe('My tickets (S5-MYTICKETS)', () => {
  it('needsYouNow: due within 2 days, critical, unread or review; never done', () => {
    const { get } = harness(3); // Chary
    const A = myTickets(get());
    expect(keys(A.filter(needsYouNow)).sort()).toEqual(['NRD-4', 'PMT-10', 'PMT-11', 'PMT-12', 'PMT-20']);
    expect(keys(filterView(A, 'crit'))).toEqual(['PMT-11']);
    expect(filterView(A, 'all')).toHaveLength(A.length);
    const done = { ...A[0], st: 'done' as const, prio: 'Critical' as const };
    expect(needsYouNow(done)).toBe(false);
  });

  it('sorts not-done first, then by due date', () => {
    const { get } = harness(1); // Rahul: PMT-12, PMT-20, PMT-22 (done), INT-5
    expect(keys(sortTickets(myTickets(get())))).toEqual(['PMT-20', 'PMT-12', 'INT-5', 'PMT-22']);
  });

  it('groups by due date in the fixed order', () => {
    const { get } = harness(3);
    const G = groupTickets(get(), myTickets(get()), 'due');
    expect(G.map((g) => g.title)).toEqual(['Overdue', 'Today', 'This week']);
    expect(keys(G[0].tickets)).toEqual(['PMT-11', 'PMT-20']);
    expect(G[1].sub).toBe('1 ticket');
    expect(G[2].sub).toBe('3 tickets');
    expect(dueGroup({ ...G[0].tickets[0], due: '' })).toBe('No due date');
  });

  it('groups by sprint ("Epic · Sprint N" / Backlog) and by project', () => {
    const { get } = harness(3);
    const bySprint = groupTickets(get(), myTickets(get()), 'sprint').map((g) => g.title);
    expect(bySprint).toEqual(expect.arrayContaining(['Mobile app · Sprint 2', 'Web app · Sprint 3', 'Metering dashboard · Sprint 1']));
    const byProj = groupTickets(get(), myTickets(get()), 'proj').map((g) => g.title);
    expect(byProj.sort()).toEqual(['Business portal', 'Daco platform']);
    const { get: g2 } = harness(2); // Vivek: FJD-3, FJD-4 (backlog), INT-3
    expect(groupTickets(g2(), myTickets(g2()), 'sprint').map((g) => g.title)).toContain('Backlog');
  });

  it('My sprints (active only) and My epics', () => {
    const { get } = harness(1);
    const S = mySprints(get(), myTickets(get()));
    expect(S.map((x) => x.title)).toEqual(['Mobile app · Sprint 2', 'Web app · Sprint 3', 'DevOps board · Sprint 4']);
    expect(S[1].caption).toBe('1 of 2 of my tasks done · ends 11 Oct');
    const E = myEpics(get(), myTickets(get()));
    expect(E.find((e) => e.title === 'Web app')).toMatchObject({ done: 1, total: 2 });
  });
});
