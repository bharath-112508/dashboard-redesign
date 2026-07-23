/**
 * Dev-only: spread the demo's done-task completion dates across a realistic
 * gradient so the dashboard's range filter visibly changes the "Tasks
 * completed" / throughput numbers. The demo seed clustered every completion
 * on ~2 days, which made every range read the same total.
 *
 * Sets `updated_at` (the field throughput filters on) via the native driver
 * so Mongoose's timestamp plugin doesn't overwrite it. Idempotent-ish: run
 * again and it re-spreads the current done tasks. NOT for production.
 *
 *   npx tsx scripts/dev-spread-demo-completions.ts
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../src/constants/story.js';

// Noon IST (06:30 UTC) on each date, so it lands squarely inside the IST day
// the throughput aggregation buckets by.
const at = (iso: string) => new Date(`${iso}T06:30:00.000Z`);

// A gradient anchored on "today" = 2026-07-23 (IST):
//   today (Jul 23) ....... 2   completions
//   this week (Jul 20-23)  4   (2 today + Jul 21/22)
//   this month (Jul 1-23)  8   (adds Jul 4/9/14/18)
//   earlier this quarter   +5  in June (only show in custom ranges spanning June)
const COMPLETION_DATES = [
    '2026-07-23',
    '2026-07-23',
    '2026-07-22',
    '2026-07-21',
    '2026-07-18',
    '2026-07-14',
    '2026-07-09',
    '2026-07-04',
    '2026-06-26',
    '2026-06-20',
    '2026-06-14',
    '2026-06-08',
    '2026-06-02',
];

const main = async () => {
    await connectDB();
    const db = mongoose.connection.db!;
    const tasks = db.collection(COLLECTIONS.TASKS);

    const done = await tasks
        .find({ status: DEFAULT_DONE_TASK_STATUS_KEY })
        .project({ _id: 1, title: 1 })
        .toArray();

    if (done.length === 0) {
        console.log('No done tasks found — nothing to spread.');
        await disconnectDB();
        return;
    }

    console.log(`Spreading ${done.length} done task(s) across ${COMPLETION_DATES.length} dates…`);
    const perDate: Record<string, number> = {};
    for (let i = 0; i < done.length; i++) {
        const iso = COMPLETION_DATES[i % COMPLETION_DATES.length]!;
        await tasks.updateOne({ _id: done[i]!._id }, { $set: { updated_at: at(iso) } });
        perDate[iso] = (perDate[iso] ?? 0) + 1;
    }

    console.log('Done. Completions per date:', perDate);
    const inRange = (from: string, to: string) =>
        Object.entries(perDate)
            .filter(([d]) => d >= from && d <= to)
            .reduce((a, [, n]) => a + n, 0);
    console.log('Expected dashboard totals:');
    console.log('  today (2026-07-23):      ', inRange('2026-07-23', '2026-07-23'));
    console.log('  this week (07-20..07-23):', inRange('2026-07-20', '2026-07-23'));
    console.log('  this month (07-01..07-23):', inRange('2026-07-01', '2026-07-23'));
    console.log('  this quarter (=month):   ', inRange('2026-07-01', '2026-07-23'));

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
