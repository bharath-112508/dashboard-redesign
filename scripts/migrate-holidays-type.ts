/**
 * One-shot migration — `holidays.is_optional` → `holidays.type` + `description`.
 *
 *  - For every row that still has `is_optional` set:
 *      `type = is_optional === true ? 'optional' : 'public'`
 *      `description = ''`
 *      `$unset: { is_optional: 1 }`
 *  - Rows that already have `type` set are skipped (idempotent — safe
 *    to re-run, e.g. against a partial migration).
 *
 * Hard-drops the legacy field. There are no FK references to
 * `is_optional` (leave/attendance engines key off `date`), so a
 * straight `$unset` is safe per the model's own docstring.
 *
 * Run:  npx tsx scripts/migrate-holidays-type.ts
 *
 * Refuses to run unless the connected DB name is in the safelist below
 * — defence in depth against accidental prod migrations until you've
 * had a chance to review the diff.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
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

    const collection = mongoose.connection.collection('holidays');

    // Audit before — counts of legacy rows that need touching.
    const totalCount = await collection.countDocuments();
    const legacyCount = await collection.countDocuments({
        is_optional: { $exists: true },
    });
    const alreadyMigrated = await collection.countDocuments({
        type: { $exists: true },
    });
    logger.info({ dbName, totalCount, legacyCount, alreadyMigrated }, 'holidays migration — before');

    if (legacyCount === 0) {
        logger.info('Nothing to migrate. Exiting.');
        await disconnectDB();
        return;
    }

    // Two updateMany calls so the resulting `type` matches the old flag.
    const optionalResult = await collection.updateMany(
        { is_optional: true },
        {
            $set: { type: 'optional', description: '' },
            $unset: { is_optional: '' },
        }
    );

    const publicResult = await collection.updateMany(
        { is_optional: false },
        {
            $set: { type: 'public', description: '' },
            $unset: { is_optional: '' },
        }
    );

    // Sanity — any holiday rows still missing the new `type` after the
    // run (shouldn't happen, but cheap to verify).
    const stillUntyped = await collection.countDocuments({
        type: { $exists: false },
    });
    logger.info(
        {
            promotedToOptional: optionalResult.modifiedCount,
            promotedToPublic: publicResult.modifiedCount,
            stillUntyped,
        },
        'holidays migration — after'
    );

    if (stillUntyped > 0) {
        logger.warn(`${stillUntyped} rows have neither \`is_optional\` nor \`type\` — investigate manually.`);
    }

    await disconnectDB();
}

migrate().catch(async (err) => {
    logger.error({ err }, 'holidays migration failed');
    await disconnectDB().catch(() => {
        /* swallow disconnect errors during cleanup */
    });
    process.exit(1);
});
