/**
 * Migration — backfill `Task.completed_at` for tasks that were already `done`
 * before the field existed.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass `--commit`.
 *
 *   npx tsx scripts/migrate-task-completed-at.ts             # plan only
 *   npx tsx scripts/migrate-task-completed-at.ts --commit    # apply
 *
 * What it does:
 *   - For every task with `status === 'done'` and no `completed_at` yet, sets
 *     `completed_at = updated_at` (the best available proxy for when it was
 *     completed — there was no dedicated timestamp before this change).
 *   - Leaves non-done tasks alone (their `completed_at` stays `null`).
 *
 * Uses the native driver so Mongoose's timestamp plugin doesn't bump
 * `updated_at`. Re-runnable: it only touches done tasks still missing the
 * field, so a second run is a clean no-op.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../src/constants/story.js';

const COMMIT = process.argv.includes('--commit');

const main = async () => {
    await connectDB();
    const tasks = mongoose.connection.db!.collection(COLLECTIONS.TASKS);

    // Done tasks that don't yet have a real completion timestamp.
    const filter = {
        status: DEFAULT_DONE_TASK_STATUS_KEY,
        $or: [{ completed_at: { $exists: false } }, { completed_at: null }],
    };

    const pending = await tasks.countDocuments(filter);
    const totalDone = await tasks.countDocuments({ status: DEFAULT_DONE_TASK_STATUS_KEY });
    console.log(`Done tasks: ${totalDone}. Missing completed_at: ${pending}.`);

    if (pending === 0) {
        console.log('Nothing to backfill — already up to date.');
        await disconnectDB();
        return;
    }

    if (!COMMIT) {
        const sample = await tasks.find(filter).project({ title: 1, updated_at: 1 }).limit(10).toArray();
        console.log('DRY RUN — would set completed_at = updated_at for these (first 10 shown):');
        for (const t of sample) console.log(`  • ${t.title} → ${new Date(t.updated_at as Date).toISOString()}`);
        console.log(`\nRe-run with --commit to apply to all ${pending} task(s).`);
        await disconnectDB();
        return;
    }

    // completed_at := updated_at, done via an aggregation-pipeline update so
    // each row copies its own updated_at.
    const res = await tasks.updateMany(filter, [{ $set: { completed_at: '$updated_at' } }]);
    console.log(`Committed. Matched ${res.matchedCount}, modified ${res.modifiedCount}.`);

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
