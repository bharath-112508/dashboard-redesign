/**
 * One-shot migration — backfill `tasks.task_number` + `projects.task_seq`.
 *
 * Issue keys render as `{project.code}-{task_number}`. Existing tasks predate
 * the field, so this script assigns each project's tasks a stable number by
 * creation order and sets the project's `task_seq` counter to the max.
 *
 *  - For each project, load its tasks WITHOUT a `task_number`, sorted by
 *    `created_at` ascending, and number them continuing from the highest
 *    number the project already has (so re-running after a partial run
 *    doesn't collide).
 *  - Set `projects.task_seq` to `max(existing task_seq, highest number)`.
 *  - Idempotent — tasks that already have a `task_number` are skipped.
 *
 * Run (preview, no writes):  npx tsx scripts/backfill-task-numbers.ts --dry-run
 * Run (apply):               npx tsx scripts/backfill-task-numbers.ts
 *
 * Writes refuse to run unless the connected DB name is in the safelist below
 * — defence in depth against accidental prod migrations. `--dry-run` is
 * read-only and always allowed.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import logger from '../src/utils/logger.js';

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
    code: string;
    task_seq?: number;
}

interface TaskRow {
    _id: mongoose.Types.ObjectId;
    task_number?: number;
}

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

    const projectRows = (await projects.find({}).project({ code: 1, task_seq: 1 }).toArray()) as ProjectRow[];
    logger.info({ dbName, dryRun: DRY_RUN, projectCount: projectRows.length }, 'task_number backfill — start');

    let projectsTouched = 0;
    let tasksNumbered = 0;

    for (const project of projectRows) {
        // Tasks in this project that still need a number, oldest first so the
        // key order matches creation order (VLJ-1 = the first task created).
        const pending = (await tasks
            .find({ project_id: project._id, task_number: { $exists: false } })
            .project({ _id: 1 })
            .sort({ created_at: 1, _id: 1 })
            .toArray()) as TaskRow[];

        // Continue numbering above any numbers already present (partial re-run).
        const maxExisting = (await tasks
            .find({ project_id: project._id, task_number: { $exists: true } })
            .project({ task_number: 1 })
            .sort({ task_number: -1 })
            .limit(1)
            .toArray()) as TaskRow[];
        let next = (maxExisting[0]?.task_number ?? 0) + 1;

        if (pending.length === 0) {
            // Still ensure task_seq is at least the highest existing number.
            const desiredSeq = Math.max(project.task_seq ?? 0, next - 1);
            if (!DRY_RUN && desiredSeq !== (project.task_seq ?? 0)) {
                await projects.updateOne({ _id: project._id }, { $set: { task_seq: desiredSeq } });
            }
            continue;
        }

        for (const task of pending) {
            if (!DRY_RUN) {
                await tasks.updateOne({ _id: task._id }, { $set: { task_number: next } });
            }
            next += 1;
            tasksNumbered += 1;
        }

        const desiredSeq = Math.max(project.task_seq ?? 0, next - 1);
        if (!DRY_RUN) {
            await projects.updateOne({ _id: project._id }, { $set: { task_seq: desiredSeq } });
        }
        projectsTouched += 1;
        logger.info(
            { code: project.code, numbered: pending.length, task_seq: desiredSeq },
            DRY_RUN ? 'would number tasks' : 'numbered tasks'
        );
    }

    logger.info({ dbName, dryRun: DRY_RUN, projectsTouched, tasksNumbered }, 'task_number backfill — done');

    await disconnectDB();
}

migrate().catch(async (err) => {
    logger.error({ err }, 'task_number backfill failed');
    await disconnectDB().catch(() => {
        /* swallow disconnect errors during cleanup */
    });
    process.exit(1);
});
