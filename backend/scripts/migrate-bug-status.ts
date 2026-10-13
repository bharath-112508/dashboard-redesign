/**
 * Add the `bug` built-in status to every project's `default_status_orders`.
 *
 * DRY-RUN BY DEFAULT. Pass `--commit` to write; writing to a database not in
 * SAFE_DB_NAMES also needs `--allow-prod`. Idempotent — re-running skips
 * projects that already have `bug`. Projects with a CUSTOM status keyed `bug`
 * are skipped and listed: rename that custom status, then re-run.
 *
 *   npx tsx scripts/migrate-bug-status.ts [--commit] [--allow-prod]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { COLLECTIONS } from '../src/constants/collections.js';
import { planBugStatusMigration } from '../src/utils/bug-status-migration.js';
import { SAFE_DB_NAMES } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const ALLOW_PROD = process.argv.includes('--allow-prod');

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const db = mongoose.connection.db!;
    if (COMMIT && !SAFE_DB_NAMES.has(db.databaseName) && !ALLOW_PROD) {
        throw new Error(
            `Refusing to write to '${db.databaseName}' — it is not in SAFE_DB_NAMES. Re-run with --allow-prod if you mean it.`
        );
    }
    const projects = await db
        .collection(COLLECTIONS.PROJECTS)
        .find({}, { projection: { name: 1, default_status_orders: 1, custom_task_statuses: 1 } })
        .toArray();
    const plan = planBugStatusMigration(
        projects.map((x) => ({
            _id: String(x._id),
            name: String(x.name ?? ''),
            default_status_orders: x.default_status_orders,
            custom_task_statuses: x.custom_task_statuses,
        }))
    );
    console.log(
        `DB ${db.databaseName}: ${plan.toUpdate.length} to update, ${plan.alreadyDone} already done, ${plan.conflicts.length} conflict(s)`
    );
    for (const c of plan.conflicts) console.log(`  CONFLICT — custom status "bug" on ${c.name} (${c.id})`);

    if (!COMMIT) {
        console.log('DRY RUN — nothing written. Re-run with --commit to apply.');
    } else if (plan.toUpdate.length > 0) {
        const res = await db.collection(COLLECTIONS.PROJECTS).updateMany(
            {
                _id: { $in: plan.toUpdate.map((id) => new mongoose.Types.ObjectId(id)) },
                'default_status_orders.key': { $ne: 'bug' },
            },
            { $push: { default_status_orders: { key: 'bug', order: 250, is_active: true } } } as never
        );
        console.log(`Updated ${res.modifiedCount} project(s).`);
    }
    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
