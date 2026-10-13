/**
 * Migration — backfill `Task.assignee_ids` from the legacy single
 * `primary_assignee_id`.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass `--commit`.
 *
 *   npx tsx scripts/migrate-task-assignees.ts             # plan only
 *   npx tsx scripts/migrate-task-assignees.ts --commit    # apply
 *
 * Context: tasks gained a multi-assignee `assignee_ids[]` array (the source of
 * truth for assignment); `primary_assignee_id` is now a denormalized
 * convenience kept in sync as `assignee_ids[0]`. Rows created before the array
 * existed carry only `primary_assignee_id`, so they'd read as having zero
 * assignees under the new multi-assignee filter. This script seeds the array:
 *   - `primary_assignee_id` set  → `assignee_ids = [primary_assignee_id]`
 *   - `primary_assignee_id` null → `assignee_ids = []`
 *
 * Uses the native driver so Mongoose's timestamp plugin doesn't bump
 * `updated_at`. Re-runnable: it only touches rows that don't yet have a
 * populated `assignee_ids`, so a second run is a clean no-op.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';

const COMMIT = process.argv.includes('--commit');

const main = async () => {
    await connectDB();
    const tasks = mongoose.connection.db!.collection(COLLECTIONS.TASKS);

    // Rows that don't yet carry a populated assignee_ids array. The native
    // driver matches `{ $exists: false }` and explicit-`[]`/null alike; we then
    // split by whether there's a primary to seed from.
    const missing = {
        $or: [
            { assignee_ids: { $exists: false } },
            { assignee_ids: { $size: 0 } },
            { assignee_ids: null },
        ],
    };

    const withPrimary = {
        ...missing,
        primary_assignee_id: { $ne: null, $exists: true },
    };

    const pending = await tasks.countDocuments(missing);
    const seedable = await tasks.countDocuments(withPrimary);
    console.log(
        `Tasks missing assignee_ids: ${pending} (of which ${seedable} have a primary_assignee_id to seed from).`
    );

    if (pending === 0) {
        console.log('Nothing to backfill — already up to date.');
        await disconnectDB();
        return;
    }

    if (!COMMIT) {
        const sample = await tasks
            .find(withPrimary)
            .project({ title: 1, primary_assignee_id: 1 })
            .limit(10)
            .toArray();
        console.log('DRY RUN — would set assignee_ids = [primary_assignee_id] for these (first 10 shown):');
        for (const t of sample) {
            console.log(`  • ${String(t.title)} → [${String(t.primary_assignee_id)}]`);
        }
        console.log(`\nRe-run with --commit to apply to all ${seedable} seedable task(s).`);
        await disconnectDB();
        return;
    }

    // assignee_ids := [primary_assignee_id] where there is one, via an
    // aggregation-pipeline update so each row copies its own primary.
    const res = await tasks.updateMany(withPrimary, [
        { $set: { assignee_ids: ['$primary_assignee_id'] } },
    ]);
    console.log(`Committed. Matched ${res.matchedCount}, modified ${res.modifiedCount}.`);

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
