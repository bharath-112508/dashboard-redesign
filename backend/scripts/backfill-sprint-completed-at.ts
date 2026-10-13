/**
 * Migration — backfill `Sprint.completed_at` for sprints that were already
 * `completed` before the field existed.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass `--commit`.
 *
 *   npx tsx scripts/backfill-sprint-completed-at.ts             # plan only
 *   npx tsx scripts/backfill-sprint-completed-at.ts --commit    # apply
 *
 * What it does:
 *   - For every sprint with `status === 'completed'` and no `completed_at`
 *     yet, sets `completed_at = end_date` (noon UTC on that day).
 *   - Leaves non-completed sprints alone (their `completed_at` stays `null`).
 *
 * Why `end_date` and not `updated_at` (which the task backfill used): a
 * completed sprint has no recorded completion moment, and `updated_at` on
 * historical/seeded rows is the seed time — often long after the sprint's
 * window — which would paint on-schedule sprints as wildly "late". Assuming a
 * historical sprint closed on its planned `end_date` is the conservative,
 * non-misleading default (it reads as "on time"). Sprints completed AFTER
 * this change get the real completion timestamp from the service.
 *
 * Uses the native driver so Mongoose's timestamp plugin doesn't bump
 * `updated_at`. Re-runnable: it only touches completed sprints still missing
 * the field, so a second run is a clean no-op.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { SPRINT_STATUSES } from '../src/constants/project.js';

const COMMIT = process.argv.includes('--commit');

const main = async () => {
    await connectDB();
    const sprints = mongoose.connection.db!.collection(COLLECTIONS.SPRINTS);

    // Completed sprints that don't yet have a completion timestamp.
    const filter = {
        status: SPRINT_STATUSES.COMPLETED,
        $or: [{ completed_at: { $exists: false } }, { completed_at: null }],
    };

    const pending = await sprints.countDocuments(filter);
    const totalDone = await sprints.countDocuments({ status: SPRINT_STATUSES.COMPLETED });
    console.log(`Completed sprints: ${totalDone}. Missing completed_at: ${pending}.`);

    if (pending === 0) {
        console.log('Nothing to backfill — already up to date.');
        await disconnectDB();
        return;
    }

    if (!COMMIT) {
        const sample = await sprints.find(filter).project({ name: 1, end_date: 1 }).limit(10).toArray();
        console.log('DRY RUN — would set completed_at = end_date (noon UTC) for these (first 10 shown):');
        for (const s of sample) console.log(`  • ${s.name} → ${s.end_date}T12:00:00Z`);
        console.log(`\nRe-run with --commit to apply to all ${pending} sprint(s).`);
        await disconnectDB();
        return;
    }

    // completed_at := end_date at noon UTC, via an aggregation-pipeline update
    // so each row parses its own end_date string.
    const res = await sprints.updateMany(filter, [
        {
            $set: {
                completed_at: {
                    $dateFromString: {
                        dateString: { $concat: ['$end_date', 'T12:00:00Z'] },
                    },
                },
            },
        },
    ]);
    console.log(`Committed. Matched ${res.matchedCount}, modified ${res.modifiedCount}.`);

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
