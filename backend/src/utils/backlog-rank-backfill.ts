import { type Types } from 'mongoose';

/**
 * Pure core of the `scripts/backfill-backlog-rank.ts` migration (Phase 2
 * Backlog screen). Extracted here — away from the DB-driven script shell — so
 * the ordering + idempotency guarantees can be unit-tested without a live
 * Mongo connection (the migration script itself lives under `scripts/**`,
 * which the vitest config excludes).
 *
 * `backlog_rank` is a dense integer scoped to `project_id` that orders the
 * Backlog + every sprint list in one continuous sequence.
 */

export interface BacklogRankTaskRow {
    _id: Types.ObjectId;
    sprint_id?: Types.ObjectId | null;
    created_at?: Date;
    backlog_rank?: number;
}

/**
 * Sort comparator matching the design contract: sprinted tasks first (a
 * present `sprint_id` sorts ahead of a null/absent one — they render in the
 * sprint sections at the top of the Backlog screen, so they take the lower
 * ranks), then `created_at` ascending within each group, with a final `_id`
 * tiebreaker so the order is fully deterministic.
 */
export const byRankOrder = (a: BacklogRankTaskRow, b: BacklogRankTaskRow): number => {
    const aHasSprint = a.sprint_id != null ? 0 : 1;
    const bHasSprint = b.sprint_id != null ? 0 : 1;
    if (aHasSprint !== bHasSprint) return aHasSprint - bHasSprint;
    const at = a.created_at ? a.created_at.getTime() : 0;
    const bt = b.created_at ? b.created_at.getTime() : 0;
    if (at !== bt) return at - bt;
    return a._id.toString().localeCompare(b._id.toString());
};

/**
 * Given a project's un-ranked `pending` tasks and the highest `backlog_rank`
 * already present (or `null` when none), return the `{ _id, backlog_rank }`
 * assignments in application order. Continuing above `maxExisting` is what the
 * idempotency guarantee rests on — a re-run over the remaining un-ranked rows
 * numbers them above the ranks a prior partial run already assigned.
 */
export const computeRankAssignments = (
    pending: readonly BacklogRankTaskRow[],
    maxExisting: number | null
): Array<{ _id: Types.ObjectId; backlog_rank: number }> => {
    let next = maxExisting != null ? maxExisting + 1 : 0;
    return [...pending].sort(byRankOrder).map((task) => ({ _id: task._id, backlog_rank: next++ }));
};
