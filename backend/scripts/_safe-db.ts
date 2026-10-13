import mongoose from 'mongoose';

/**
 * Shared safelist guard for destructive dev/demo scripts.
 *
 * `demo-wipe.ts` had this check inline and the other two destructive scripts
 * had nothing, which is the worst arrangement: the one that reads as most
 * dangerous was guarded, and `smoke-reset-users.ts` — which runs
 * `User.deleteMany({ email: { $ne: SEED_EMAIL } })`, i.e. deletes every user
 * but one — was not. `npm run smoke` calls it by default, so pointing `.env`
 * at production and running the smoke suite would empty the user table.
 *
 * A comment saying "NOT for production" is not a guard. This is.
 *
 * Widen `SAFE_DB_NAMES` deliberately, never reflexively — every name here is
 * a database somebody is allowed to destroy.
 */
export const SAFE_DB_NAMES = new Set(['timesheets', 'timesheets_dev', 'timesheets_test', 'vilje-platform-demo']);

/**
 * Throws unless the connected database is on the safelist. Call immediately
 * after `connectDB()` and before the first write.
 */
export const assertSafeDb = (scriptName: string): string => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    if (!SAFE_DB_NAMES.has(db.databaseName)) {
        throw new Error(
            `Refusing to run ${scriptName} against DB '${db.databaseName}' — not in ` +
                'SAFE_DB_NAMES. This script is destructive and the database does not ' +
                'look like a dev/demo one. If you really mean it, add the name in ' +
                'scripts/_safe-db.ts.'
        );
    }
    return db.databaseName;
};
