/**
 * One-shot migration — backfill `projects.default_status_orders`.
 *
 *  - For every project that doesn't yet have `default_status_orders` set
 *    (or has it as an empty array), seed the canonical 100 / 200 / 300 /
 *    400 ordering of the four built-in statuses.
 *  - Idempotent — projects with the field already populated are skipped.
 *
 * Background: the four built-in task statuses (`to_do`, `in_progress`,
 * `review`, `done`) used to render in a fixed order on the board. We
 * added a project-scoped `default_status_orders[]` array so admins can
 * interleave defaults with custom statuses. New projects get the field
 * seeded automatically via the schema default; this script handles
 * projects that existed BEFORE the schema change.
 *
 * Run:  npx tsx scripts/migrate-default-status-orders.ts
 *
 * Refuses to run unless the connected DB name is in the safelist below
 * — defence in depth against accidental prod migrations.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { buildCanonicalDefaultOrders } from '../src/constants/project.js';
import logger from '../src/utils/logger.js';

const SAFE_DB_NAMES = new Set(['timesheets', 'timesheets_dev', 'timesheets_test']);

async function migrate(): Promise<void> {
    await connectDB();
    const dbName = mongoose.connection.db?.databaseName;
    if (!dbName) {
        throw new Error('Database connection has no `databaseName`.');
    }
    if (!SAFE_DB_NAMES.has(dbName)) {
        logger.error(
            { dbName, allowed: Array.from(SAFE_DB_NAMES) },
            'Refusing to run migration — add the DB name to SAFE_DB_NAMES first.'
        );
        await disconnectDB();
        process.exit(1);
    }

    const collection = mongoose.connection.collection('projects');
    const canonical = buildCanonicalDefaultOrders();

    const totalCount = await collection.countDocuments();
    const missingCount = await collection.countDocuments({
        $or: [
            { default_status_orders: { $exists: false } },
            { default_status_orders: { $size: 0 } },
        ],
    });
    const alreadyHas = totalCount - missingCount;
    logger.info(
        { dbName, totalCount, missingCount, alreadyHas },
        'projects.default_status_orders migration — before'
    );

    if (missingCount === 0) {
        logger.info('Nothing to migrate. Exiting.');
        await disconnectDB();
        return;
    }

    const result = await collection.updateMany(
        {
            $or: [
                { default_status_orders: { $exists: false } },
                { default_status_orders: { $size: 0 } },
            ],
        },
        { $set: { default_status_orders: canonical } }
    );

    const stillMissing = await collection.countDocuments({
        $or: [
            { default_status_orders: { $exists: false } },
            { default_status_orders: { $size: 0 } },
        ],
    });

    // Backfill `is_active: true` on individual sub-doc entries that
    // were seeded BEFORE the field existed. We use array filters so
    // we only touch elements where `is_active` is actually missing —
    // entries that already have the field (true OR false) are left as
    // they were.
    const defaultsMissingActive = await collection.updateMany(
        { 'default_status_orders.is_active': { $exists: false } },
        { $set: { 'default_status_orders.$[elem].is_active': true } },
        { arrayFilters: [{ 'elem.is_active': { $exists: false } }] }
    );

    const customsMissingActive = await collection.updateMany(
        { 'custom_task_statuses.is_active': { $exists: false } },
        { $set: { 'custom_task_statuses.$[elem].is_active': true } },
        { arrayFilters: [{ 'elem.is_active': { $exists: false } }] }
    );

    logger.info(
        {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            stillMissing,
            defaultsActiveBackfilled: defaultsMissingActive.modifiedCount,
            customsActiveBackfilled: customsMissingActive.modifiedCount,
        },
        'projects.default_status_orders migration — after'
    );

    if (stillMissing > 0) {
        logger.warn(
            `${stillMissing} projects still missing default_status_orders — investigate manually.`
        );
    }

    await disconnectDB();
}

migrate().catch(async (err) => {
    logger.error({ err }, 'default_status_orders migration failed');
    await disconnectDB().catch(() => {
        /* swallow disconnect errors during cleanup */
    });
    process.exit(1);
});
