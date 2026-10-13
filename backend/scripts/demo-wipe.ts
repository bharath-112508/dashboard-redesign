/**
 * DEMO wipe — clears all business data while preserving:
 *   - the `admin@viljetech.com` user document (everything else in `users` is deleted)
 *   - `system_settings` (branding / policy tweaks survive)
 *   - `roles` (system + custom role catalog)
 *   - `leave_types` (system leave catalog)
 *
 * Every other collection enumerated in `src/constants/collections.ts` has ALL
 * of its documents deleted (deleteMany — collections + indexes stay in place).
 *
 * Refuses to run unless the connected DB name is in the safelist below
 * (same defence-in-depth pattern as scripts/wipe-and-seed-admin.ts).
 *
 * Run:  npx tsx scripts/demo-wipe.ts
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { assertSafeDb } from './_safe-db.js';

// Collections left completely untouched.
const KEEP_COLLECTIONS = new Set<string>([COLLECTIONS.SYSTEM_SETTINGS, COLLECTIONS.ROLES, COLLECTIONS.LEAVE_TYPES]);

const KEEP_ADMIN_EMAIL = 'admin@viljetech.com';

async function main(): Promise<void> {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error('Mongo connection not ready');

    assertSafeDb('demo-wipe.ts');

    console.log(`Connected to '${db.databaseName}'`);
    console.log(`Keeping untouched: ${[...KEEP_COLLECTIONS].join(', ')}`);
    console.log(`Keeping user: ${KEEP_ADMIN_EMAIL}\n`);

    const rows: Array<{ collection: string; before: number; after: number }> = [];

    for (const name of Object.values(COLLECTIONS)) {
        const col = db.collection(name);
        const before = await col.countDocuments();

        if (KEEP_COLLECTIONS.has(name)) {
            rows.push({ collection: `${name} (kept)`, before, after: before });
            continue;
        }

        if (name === COLLECTIONS.USERS) {
            await col.deleteMany({ email: { $ne: KEEP_ADMIN_EMAIL } });
        } else {
            await col.deleteMany({});
        }

        const after = await col.countDocuments();
        rows.push({ collection: name, before, after });
    }

    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(pad('collection', 36) + pad('before', 10) + 'after');
    console.log('─'.repeat(54));
    for (const r of rows) {
        console.log(pad(r.collection, 36) + pad(String(r.before), 10) + String(r.after));
    }

    const admin = await db.collection(COLLECTIONS.USERS).findOne({ email: KEEP_ADMIN_EMAIL });
    console.log(`\nAdmin preserved: ${admin ? 'YES (' + String(admin._id) + ')' : 'NO — MISSING!'}`);

    await disconnectDB();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
