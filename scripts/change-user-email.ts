/**
 * Change a user's login email — including the admin account.
 *
 * Written for handing the admin account to a different person, which is NOT
 * just an email edit. Three things travel with the account and each one is a
 * way for the handover to go wrong:
 *
 *   slack_user_id  — THE IMPORTANT ONE. `resolveSlackUser` checks
 *                    `findOne({ slack_user_id })` FIRST and only falls back to
 *                    email. So a stale id left on the row means the PREVIOUS
 *                    person's Slack account still resolves to this account —
 *                    they keep approving leave as the admin, and the new
 *                    owner's email is never consulted. This script clears it,
 *                    so the next inbound Slack event re-resolves by email and
 *                    re-caches against the right human.
 *
 *   mfa_enabled    — the TOTP secret belongs to the previous person's phone.
 *                    The new owner cannot log in and cannot self-serve out of
 *                    it. Reported always; cleared only with --clear-mfa.
 *
 *   refresh tokens — the previous person's live sessions keep working under
 *                    the new identity. Revoked whenever the email changes.
 *
 * The password is deliberately NOT touched: it is the same account, and the
 * new owner needs a way in. Send them through `POST /auth/forgot-password` on
 * the new address once this has run.
 *
 * Usage — from `viljetech-platform-backend/`:
 *
 *   npx tsx scripts/change-user-email.ts \
 *     --from admin@viljetech.com --to bharath@viljetech.com --db ViljetechPlatform
 *
 *   ... then re-run with --commit once the dry run reads correctly.
 *
 * Dry run is the DEFAULT. `--db <name>` must match the database the MONGO_URI
 * resolves to — naming the target is the guard against discovering you were
 * pointed at the wrong environment after the write.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../src/constants/audit.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import logger from '../src/utils/logger.js';

const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

const COMMIT = process.argv.includes('--commit');
const CLEAR_MFA = process.argv.includes('--clear-mfa');
const FROM = arg('from')?.trim().toLowerCase();
const TO = arg('to')?.trim().toLowerCase();
const EXPECTED_DB = arg('db');

interface UserRow {
    _id: mongoose.Types.ObjectId;
    email: string;
    full_name?: string;
    role?: string;
    status?: string;
    slack_user_id?: string | null;
    mfa_enabled?: boolean;
}

async function main(): Promise<void> {
    if (!FROM || !TO || !EXPECTED_DB) {
        logger.error({}, 'Usage: --from <old email> --to <new email> --db <database> [--commit] [--clear-mfa]');
        process.exit(1);
    }
    if (FROM === TO) {
        logger.error({}, '--from and --to are the same address. Nothing to do.');
        process.exit(1);
    }

    await connectDB();
    const dbName = mongoose.connection.db?.databaseName;
    if (!dbName) throw new Error('Database connection has no `databaseName`.');
    if (dbName !== EXPECTED_DB) {
        logger.error(
            { expected: EXPECTED_DB, actual: dbName },
            'MONGO_URI resolves to a DIFFERENT database than --db. Refusing to run.'
        );
        await disconnectDB();
        process.exit(1);
    }

    const users = mongoose.connection.collection(COLLECTIONS.USERS);
    const refreshTokens = mongoose.connection.collection(COLLECTIONS.REFRESH_TOKENS);

    const subject = (await users.findOne({ email: FROM })) as UserRow | null;
    if (!subject) {
        logger.error({ email: FROM }, 'No user with that email. Nothing changed.');
        await disconnectDB();
        process.exit(1);
    }

    // `email` is unique-indexed, so a collision would surface as an E11000
    // mid-write. Check first so the dry run can report it instead.
    const collision = (await users.findOne({ email: TO })) as UserRow | null;
    if (collision) {
        logger.error(
            { email: TO, existing_id: String(collision._id), existing_role: collision.role },
            'That address already belongs to another account. Resolve the duplicate first.'
        );
        await disconnectDB();
        process.exit(1);
    }

    const liveSessions = await refreshTokens.countDocuments({
        user_id: subject._id,
        revoked_at: null,
        expires_at: { $gt: new Date() },
    });

    logger.info(
        {
            user_id: String(subject._id),
            full_name: subject.full_name,
            role: subject.role,
            status: subject.status,
            from: FROM,
            to: TO,
            mode: COMMIT ? 'COMMIT' : 'DRY RUN',
        },
        COMMIT ? 'Changing login email — WRITING' : 'Changing login email — dry run, no writes'
    );

    logger.info(
        {
            email: `${FROM} -> ${TO}`,
            slack_user_id: subject.slack_user_id
                ? `${subject.slack_user_id} -> null (re-resolves by email on next Slack event)`
                : 'already null — nothing to clear',
            refresh_tokens_to_revoke: liveSessions,
            mfa_enabled: subject.mfa_enabled ?? false,
        },
        'Planned changes'
    );

    if (subject.mfa_enabled && !CLEAR_MFA) {
        logger.warn(
            {},
            'MFA IS ENABLED on this account and the TOTP secret belongs to the PREVIOUS ' +
                "owner's device. The new owner will pass the password step and then be " +
                'unable to complete the challenge. Re-run with --clear-mfa to disable it, ' +
                'or hand over via docs/runbooks/reset-mfa.md.'
        );
    }

    if (!COMMIT) {
        logger.info({}, 'Dry run complete. Re-run with --commit to apply.');
        await disconnectDB();
        process.exit(0);
    }

    const set: Record<string, unknown> = {
        email: TO,
        // See the header: this is what stops the previous person's Slack
        // account from continuing to resolve to this row.
        slack_user_id: null,
    };
    if (CLEAR_MFA) {
        set.mfa_enabled = false;
        set.mfa_secret_encrypted = null;
        set.mfa_backup_codes_hashed = [];
    }

    await users.updateOne({ _id: subject._id }, { $set: set });

    // The previous owner's live sessions would otherwise keep working under
    // the new identity.
    const revoked = await refreshTokens.updateMany(
        { user_id: subject._id, revoked_at: null },
        { $set: { revoked_at: new Date() } }
    );

    await mongoose.connection.collection(COLLECTIONS.AUDIT_LOGS).insertOne({
        actor_id: null,
        actor_role: 'system',
        action: AUDIT_ACTIONS.USER_EMAIL_CHANGE,
        target_entity: { kind: AUDIT_TARGET_KINDS.USER, id: subject._id },
        before: { email: FROM, slack_user_id: subject.slack_user_id ?? null },
        after: { email: TO, slack_user_id: null },
        metadata: { source: 'scripts/change-user-email.ts', mfa_cleared: CLEAR_MFA },
        created_at: new Date(),
    });

    const after = (await users.findOne({ _id: subject._id })) as UserRow | null;
    logger.info(
        {
            email: after?.email,
            slack_user_id: after?.slack_user_id ?? null,
            mfa_enabled: after?.mfa_enabled ?? false,
            sessions_revoked: revoked.modifiedCount,
        },
        'Done — verified from a fresh read'
    );
    logger.info(
        {},
        'Next: send the new owner through Forgot password on the new address, and have ' +
            'them open the Slack App Home once so the mapping re-caches.'
    );

    await disconnectDB();
    process.exit(0);
}

main().catch(async (err) => {
    logger.error({ err }, 'Email change failed');
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
