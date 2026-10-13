/**
 * purge-client-side-attendance.ts
 *
 * Removes the `attendance_records` rows the EOD finalizer created for
 * **representatives**, which it should never have touched.
 *
 * ── Why these rows exist ──────────────────────────────────────────────
 *
 * The finalizer's user cursor filtered `role: { $ne: ROLES.CLIENT }`, but
 * client-side means BOTH roles — `CLIENT_SIDE_ROLES = [client,
 * representative]`. So every active representative was swept in and given an
 * `absent` placeholder every night. Fixed in the job; this cleans up what
 * already accumulated.
 *
 * They were invisible: `attendance.service.ts` filters reads with
 * `$nin: CLIENT_SIDE_ROLES`, so no report or team view ever showed them. The
 * only cost is storage — which is also why nobody noticed for as long as the
 * bug existed.
 *
 * ── Safety ────────────────────────────────────────────────────────────
 *
 * DRY-RUN BY DEFAULT. Prints the full plan and writes nothing.
 * Pass `--commit` to apply.
 *
 *   npx tsx scripts/purge-client-side-attendance.ts             # inspect
 *   npx tsx scripts/purge-client-side-attendance.ts --commit    # apply
 *
 * Deletes ONLY rows that are unambiguously finalizer placeholders:
 *
 *   check_in === null AND check_out === null AND (segments empty or absent)
 *
 * A client-side row carrying ANY real punch data is **reported and kept**.
 * That should be impossible — client-side roles hold no
 * `attendance.check_in_out` permission — so if the script finds one, that is
 * a different and more interesting bug than the one this cleans up, and
 * deleting it would destroy the evidence.
 *
 * Re-runnable: a second run finds nothing and exits cleanly.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { CLIENT_SIDE_ROLES } from '../src/constants/roles.js';

const COMMIT = process.argv.includes('--commit');

const log = (...args: unknown[]): void => console.log(...args);

const run = async (): Promise<void> => {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle');

    log('');
    log('══════════════════════════════════════════════════════════════');
    log(COMMIT ? '  PURGE — COMMIT MODE (deletes will be applied)' : '  PURGE — DRY RUN (nothing will be written)');
    log(`  database: ${mongoose.connection.name}`);
    log('══════════════════════════════════════════════════════════════');
    log('');

    const users = db.collection(COLLECTIONS.USERS);
    const attendance = db.collection(COLLECTIONS.ATTENDANCE_RECORDS);

    // Every client-side user, ACTIVE OR NOT — a representative deactivated
    // last month still has rows from while they were active.
    const clientSide = await users
        .find({ role: { $in: CLIENT_SIDE_ROLES } }, { projection: { _id: 1, full_name: 1, email: 1, role: 1 } })
        .toArray();

    if (clientSide.length === 0) {
        log('No client-side users found. Nothing to do.');
        await disconnectDB();
        return;
    }

    const ids = clientSide.map((u) => u._id);
    log(`Client-side users: ${clientSide.length}`);
    for (const r of CLIENT_SIDE_ROLES) {
        log(`  ${r}: ${clientSide.filter((u) => u.role === r).length}`);
    }
    log('');

    const total = await attendance.countDocuments({ user_id: { $in: ids } });
    if (total === 0) {
        log('No attendance rows for client-side users. Already clean.');
        await disconnectDB();
        return;
    }

    // Placeholders: no punch data of any kind. Anything else is kept.
    const placeholderFilter = {
        user_id: { $in: ids },
        check_in: null,
        check_out: null,
        $or: [{ segments: { $exists: false } }, { segments: { $size: 0 } }],
    };

    const placeholders = await attendance.countDocuments(placeholderFilter);
    const withData = total - placeholders;

    log(`Attendance rows for client-side users: ${total}`);
    log(`  placeholders (safe to delete):       ${placeholders}`);
    log(`  carrying punch data (WILL BE KEPT):  ${withData}`);
    log('');

    // Status breakdown, so the operator can sanity-check that this is the
    // finalizer's output and not something else entirely.
    const byStatus = await attendance
        .aggregate([
            { $match: placeholderFilter },
            { $group: { _id: '$status', n: { $sum: 1 } } },
            { $sort: { n: -1 } },
        ])
        .toArray();
    if (byStatus.length > 0) {
        log('Placeholder rows by status:');
        for (const s of byStatus) log(`  ${String(s._id).padEnd(12)} ${s.n}`);
        log('');
    }

    const range = await attendance
        .aggregate([
            { $match: placeholderFilter },
            { $group: { _id: null, min: { $min: '$local_date' }, max: { $max: '$local_date' } } },
        ])
        .toArray();
    if (range[0]) log(`Date range: ${range[0].min} → ${range[0].max}`);
    log('');

    if (withData > 0) {
        log('⚠️  SOME CLIENT-SIDE ROWS CARRY PUNCH DATA AND WILL NOT BE DELETED.');
        log('   Client-side roles hold no `attendance.check_in_out` permission, so');
        log('   this should be impossible. Investigate before purging — it is a');
        log('   different bug from the one this script cleans up.');
        const sample = await attendance
            .find(
                { user_id: { $in: ids }, $nor: [placeholderFilter] },
                { projection: { user_id: 1, local_date: 1, status: 1, check_in: 1 }, limit: 5 }
            )
            .toArray();
        for (const r of sample) {
            const u = clientSide.find((x) => String(x._id) === String(r.user_id));
            log(`     ${r.local_date}  ${u?.email ?? r.user_id}  status=${r.status}`);
        }
        log('');
    }

    if (!COMMIT) {
        log(`DRY RUN — nothing written. Re-run with --commit to delete ${placeholders} row(s).`);
        await disconnectDB();
        return;
    }

    if (placeholders === 0) {
        log('Nothing to delete.');
        await disconnectDB();
        return;
    }

    const res = await attendance.deleteMany(placeholderFilter);
    log(`Deleted ${res.deletedCount} placeholder row(s).`);
    log('');
    log('The finalizer no longer creates these — see the `$nin: CLIENT_SIDE_ROLES`');
    log('filter in jobs/attendance-finalizer.job.ts. This script is re-runnable.');

    await disconnectDB();
};

run().catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
