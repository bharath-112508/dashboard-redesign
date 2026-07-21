/**
 * One-shot migration — backfill `tasks.backlog_rank` (Phase 2 Backlog screen).
 *
 * `backlog_rank` is a dense integer scoped to `project_id` that orders the
 * Backlog + every sprint list in one continuous sequence (independent of the
 * per-(project,status) board `position`). Existing tasks predate the field,
 * so this script assigns each project's un-ranked tasks a stable rank.
 *
 *  - For each project, load its tasks WITHOUT a `backlog_rank`, sorted by
 *    `(sprint_id existence, created_at ascending)` — sprinted tasks first
 *    (they render in the sprint sections at the top of the Backlog screen,
 *    so they take the lower ranks), then backlog tasks, each group oldest
 *    first. Number them continuing from the highest rank the project already
 *    has (so re-running after a partial run doesn't collide).
 *  - Idempotent — tasks that already have a `backlog_rank` are skipped, and
 *    numbering continues above the current per-project max.
 *
 * Run (preview, no writes):  npx tsx scripts/backfill-backlog-rank.ts --dry-run
 * Run (apply):               npx tsx scripts/backfill-backlog-rank.ts
 *
 * Writes refuse to run unless the connected DB name is in the safelist below
 * — defence in depth against accidental prod migrations. `--dry-run` is
 * read-only and always allowed.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import logger from '../src/utils/logger.js';
import { computeRankAssignments, type BacklogRankTaskRow } from '../src/utils/backlog-rank-backfill.js';

const SAFE_DB_NAMES = new Set([
    'timesheets',
    'timesheets_dev',
    'timesheets_test',
    'vilje-platform',
    'vilje-platform-demo',
    'vilje-platform-dev',
]);

const DRY_RUN = process.argv.includes('--dry-run');

interface ProjectRow {
    _id: mongoose.Types.ObjectId;
    code?: string;
}

// The pure ordering + assignment core lives in `src/utils/backlog-rank-backfill`
// so it can be unit-tested (this script's directory is excluded from vitest).

async function migrate(): Promise<void> {
    await connectDB();
    const dbName = mongoose.connection.db?.databaseName;
    if (!dbName) {
        throw new Error('Database connection has no `databaseName`.');
    }
    if (!DRY_RUN && !SAFE_DB_NAMES.has(dbName)) {
        logger.error(
            { dbName, allowed: Array.from(SAFE_DB_NAMES) },
            'Refusing to run migration — add the DB name to SAFE_DB_NAMES or use --dry-run.'
        );
        await disconnectDB();
        process.exit(1);
    }

    const projects = mongoose.connection.collection('projects');
    const tasks = mongoose.connection.collection('tasks');

    const projectRows = (await projects.find({}).project({ code: 1 }).toArray()) as ProjectRow[];
    logger.info({ dbName, dryRun: DRY_RUN, projectCount: projectRows.length }, 'backlog_rank backfill — start');

    let projectsTouched = 0;
    let tasksRanked = 0;

    for (const project of projectRows) {
        // Tasks in this project that still need a rank.
        const pending = (await tasks
            .find({ project_id: project._id, backlog_rank: { $exists: false } })
            .project({ _id: 1, sprint_id: 1, created_at: 1 })
            .toArray()) as BacklogRankTaskRow[];

        if (pending.length === 0) continue;

        // Continue numbering above any ranks already present (partial re-run).
        const maxExisting = (await tasks
            .find({ project_id: project._id, backlog_rank: { $exists: true } })
            .project({ backlog_rank: 1 })
            .sort({ backlog_rank: -1 })
            .limit(1)
            .toArray()) as BacklogRankTaskRow[];
        const maxRank = maxExisting[0]?.backlog_rank != null ? maxExisting[0].backlog_rank : null;

        const assignments = computeRankAssignments(pending, maxRank);

        for (const { _id, backlog_rank } of assignments) {
            if (!DRY_RUN) {
                await tasks.updateOne({ _id }, { $set: { backlog_rank } });
            }
            tasksRanked += 1;
        }

        projectsTouched += 1;
        logger.info({ code: project.code, ranked: assignments.length }, DRY_RUN ? 'would rank tasks' : 'ranked tasks');
    }

    logger.info({ dbName, dryRun: DRY_RUN, projectsTouched, tasksRanked }, 'backlog_rank backfill — done');

    await disconnectDB();
}

migrate().catch(async (err) => {
    logger.error({ err }, 'backlog_rank backfill failed');
    await disconnectDB().catch(() => {
        /* swallow disconnect errors during cleanup */
    });
    process.exit(1);
});
