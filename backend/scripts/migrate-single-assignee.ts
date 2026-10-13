/**
 * Tickets now have ONE assignee (Jira-style). For every task with 2+
 * `assignee_ids`, keep the first as the assignee and move the rest into
 * `collaborator_ids` (Contributors) so nobody silently drops off a ticket.
 *
 * DRY-RUN BY DEFAULT. Pass `--commit` to write; writing to a database not in
 * SAFE_DB_NAMES also needs `--allow-prod`. Idempotent — a second run finds
 * nothing to do. Native driver, so `updated_at` isn't bumped.
 *
 *   npx tsx scripts/migrate-single-assignee.ts [--commit] [--allow-prod]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { COLLECTIONS } from '../src/constants/collections.js';
import { SAFE_DB_NAMES } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const ALLOW_PROD = process.argv.includes('--allow-prod');
const MULTI = { 'assignee_ids.1': { $exists: true } };

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const db = mongoose.connection.db!;
    if (COMMIT && !SAFE_DB_NAMES.has(db.databaseName) && !ALLOW_PROD) {
        throw new Error(
            `Refusing to write to '${db.databaseName}' — it is not in SAFE_DB_NAMES. Re-run with --allow-prod if you mean it.`
        );
    }
    const tasks = db.collection(COLLECTIONS.TASKS);
    const rows = await tasks
        .find(MULTI, { projection: { task_number: 1, title: 1, assignee_ids: 1 } })
        .toArray();
    console.log(`DB ${db.databaseName}: ${rows.length} task(s) with more than one assignee`);
    for (const r of rows) {
        console.log(`  #${r.task_number} ${String(r.title).slice(0, 50)} — ${r.assignee_ids.length} assignees`);
    }

    if (!COMMIT) {
        console.log('DRY RUN — nothing written. Re-run with --commit to apply.');
    } else if (rows.length > 0) {
        // One pipeline update: every `$assignee_ids` below reads the ORIGINAL array.
        const res = await tasks.updateMany(MULTI, [
            {
                $set: {
                    collaborator_ids: {
                        $setUnion: [{ $ifNull: ['$collaborator_ids', []] }, { $slice: ['$assignee_ids', 1, 1000] }],
                    },
                    assignee_ids: { $slice: ['$assignee_ids', 1] },
                    primary_assignee_id: { $arrayElemAt: ['$assignee_ids', 0] },
                },
            },
        ]);
        console.log(`Updated ${res.modifiedCount} task(s).`);
    }
    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
