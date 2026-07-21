import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { byRankOrder, computeRankAssignments, type BacklogRankTaskRow } from './backlog-rank-backfill.js';

/**
 * Unit tests for the `backfill-backlog-rank` migration core (Phase 2 Backlog).
 *
 * Coverage focus (spec §4):
 *  - ordering: sprinted tasks first, then `created_at` ascending;
 *  - idempotency: a re-run continues numbering above the current max.
 */

const row = (over: Partial<BacklogRankTaskRow> = {}): BacklogRankTaskRow => ({
    _id: new Types.ObjectId(),
    sprint_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
});

describe('byRankOrder', () => {
    it('sorts sprinted tasks ahead of backlog tasks', () => {
        const backlog = row({ sprint_id: null });
        const sprinted = row({ sprint_id: new Types.ObjectId() });
        expect([backlog, sprinted].sort(byRankOrder)).toEqual([sprinted, backlog]);
    });

    it('within a group, orders oldest created_at first', () => {
        const newer = row({ sprint_id: null, created_at: new Date('2026-03-01T00:00:00Z') });
        const older = row({ sprint_id: null, created_at: new Date('2026-01-01T00:00:00Z') });
        expect([newer, older].sort(byRankOrder)).toEqual([older, newer]);
    });
});

describe('computeRankAssignments', () => {
    it('assigns 0..N in (sprint-first, created_at asc) order from a clean slate', () => {
        const sprintId = new Types.ObjectId();
        const backlogOld = row({ sprint_id: null, created_at: new Date('2026-01-01') });
        const backlogNew = row({ sprint_id: null, created_at: new Date('2026-02-01') });
        const sprintOld = row({ sprint_id: sprintId, created_at: new Date('2026-01-15') });
        const sprintNew = row({ sprint_id: sprintId, created_at: new Date('2026-02-15') });

        const out = computeRankAssignments([backlogNew, sprintNew, backlogOld, sprintOld], null);

        // Sprinted first (oldest→newest), then backlog (oldest→newest).
        expect(out).toEqual([
            { _id: sprintOld._id, backlog_rank: 0 },
            { _id: sprintNew._id, backlog_rank: 1 },
            { _id: backlogOld._id, backlog_rank: 2 },
            { _id: backlogNew._id, backlog_rank: 3 },
        ]);
    });

    it('idempotent re-run continues numbering above the existing max', () => {
        // A prior partial run assigned ranks up to 4; the remaining un-ranked
        // rows must number 5, 6, … and never collide with 0..4.
        const a = row({ sprint_id: null, created_at: new Date('2026-01-01') });
        const b = row({ sprint_id: null, created_at: new Date('2026-01-02') });

        const out = computeRankAssignments([b, a], 4);

        expect(out).toEqual([
            { _id: a._id, backlog_rank: 5 },
            { _id: b._id, backlog_rank: 6 },
        ]);
    });

    it('is a no-op for an empty pending set', () => {
        expect(computeRankAssignments([], null)).toEqual([]);
        expect(computeRankAssignments([], 9)).toEqual([]);
    });
});
