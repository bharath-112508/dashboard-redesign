/**
 * Destructive helper — wipes every business collection in the connected
 * Mongo database (KEEP = `system_settings`), then re-seeds:
 *   - the 5 system roles (via `seedSystemRoles()`)
 *   - the default leave-types catalog (via `seedDefaultLeaveTypes()`)
 *   - a single admin user (`smoke@example.com` / `SmokeA@123!`)
 *
 * Refuses to run unless the connected DB name is in the safelist below
 * — defence in depth against accidental prod drops. Add the DB name to
 * SAFE_DB_NAMES before running against a new environment.
 *
 * Run:  npx tsx scripts/wipe-and-seed-admin.ts
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { ROLES } from '../src/constants/roles.js';
import { User } from '../src/models/user.model.js';
import { seedDefaultLeaveTypes } from '../src/services/leave-type.service.js';
import { seedSystemRoles } from '../src/services/role.service.js';
import { hashPassword } from '../src/utils/password.js';

// Safelist — refuse to drop anything in production-shaped DB names.
const SAFE_DB_NAMES = new Set(['timesheets', 'timesheets_dev', 'timesheets_test']);

// Collections we never drop. `system_settings` is intentionally preserved
// so any branding / policy tweaks survive the wipe.
const KEEP_COLLECTIONS = new Set(['system_settings']);

const ADMIN_EMAIL = 'smoke@example.com';
const ADMIN_PASSWORD = 'SmokeA@123!';
const ADMIN_FULL_NAME = 'Smoke Admin';

async function main(): Promise<void> {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error('Mongo connection not ready');

    if (!SAFE_DB_NAMES.has(db.databaseName)) {
        throw new Error(
            `Refusing to wipe DB '${db.databaseName}' — not in SAFE_DB_NAMES safelist. ` +
                `Add it to scripts/wipe-and-seed-admin.ts if you really mean it.`
        );
    }

    console.log(`Connected to '${db.databaseName}'`);

    // ─── Drop ────────────────────────────────────────────────────────────
    const cols = await db.listCollections().toArray();
    const toDrop = cols.filter((c) => !KEEP_COLLECTIONS.has(c.name));
    console.log(
        `Dropping ${toDrop.length} collection(s); keeping ${cols.length - toDrop.length} (${[...KEEP_COLLECTIONS].join(', ')})`
    );
    for (const c of toDrop) {
        try {
            await db.collection(c.name).drop();
            console.log(`  dropped ${c.name}`);
        } catch (err) {
            const e = err as { codeName?: string };
            if (e.codeName !== 'NamespaceNotFound') throw err;
        }
    }

    // ─── Re-seed system roles + default leave types ─────────────────────
    await seedSystemRoles();
    console.log('  seeded system roles');
    await seedDefaultLeaveTypes();
    console.log('  seeded default leave types');

    // ─── Seed admin ─────────────────────────────────────────────────────
    const password_hash = await hashPassword(ADMIN_PASSWORD);
    await User.create({
        email: ADMIN_EMAIL,
        password_hash,
        full_name: ADMIN_FULL_NAME,
        role: ROLES.ADMIN,
        status: 'active',
        timezone: 'Asia/Kolkata',
        mfa_enabled: false,
        failed_login_attempts: 0,
        locked_until: null,
    });
    // The user's `role_ids[]` stays empty for now; the auth service's
    // `ensureLegacyRoleAssigned` self-heals it on first /auth/me call by
    // matching the legacy `role` string to the seeded system role.
    console.log(`✓ Seeded admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);

    await disconnectDB();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
