/**
 * Step 2 of the key-rotation pipeline documented in `src/utils/crypto-aes.ts`:
 * re-encrypt every AES blob under the currently-active key.
 *
 * The registry mechanism (`MFA_ENCRYPTION_KEY_<kid>` +
 * `MFA_ENCRYPTION_ACTIVE_KID`) was built for this and steps 1 and 3 are just
 * env-var edits. Step 2 was the missing piece — without it, old blobs stay
 * readable only under the OLD key forever, so the old key can never actually
 * be retired and the rotation is cosmetic.
 *
 * Three fields carry AES blobs, all under the same key:
 *   users.mfa_secret_encrypted            — TOTP secrets. Lose these and every
 *                                            MFA user is locked out.
 *   system_settings.slack.bot_token       — the Slack bot token.
 *   project_share_links.token_encrypted   — the recoverable copy of a share
 *                                            token (the AUTHORITATIVE value is
 *                                            `token_hash`; this is only so the
 *                                            Copy-URL action works). Nullable.
 *
 * Usage — from `viljetech-platform-backend/`, with BOTH keys registered:
 *
 *   MFA_ENCRYPTION_KEY=<old>            # legacy, decrypts kid-less blobs
 *   MFA_ENCRYPTION_KEY_v2=<new>         # the new key
 *   MFA_ENCRYPTION_ACTIVE_KID=v2        # what NEW encryptions stamp
 *
 *   npx tsx scripts/rotate-encryption-key.ts --db ViljetechPlatform
 *   npx tsx scripts/rotate-encryption-key.ts --db ViljetechPlatform --commit
 *
 * Dry-run is the DEFAULT — this script exists to be pointed at production, so
 * the destructive mode is the one you have to ask for. `--db <name>` must
 * match the database the MONGO_URI actually resolves to; naming it is the
 * guard against discovering you were pointed at the wrong environment after
 * the writes. (The `SAFE_DB_NAMES` allowlist used by the other scripts is the
 * wrong shape here: it exists to keep migrations OFF production, and
 * production is precisely this script's target.)
 *
 * Re-runnable. A blob already carrying the active kid is skipped, so a second
 * run is a near-no-op and re-running after a partial failure is safe.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { MFA_ENCRYPTION_ACTIVE_KID } from '../src/config/server.config.js';
import { decryptSecret, encryptSecret } from '../src/utils/crypto-aes.js';
import logger from '../src/utils/logger.js';

const COMMIT = process.argv.includes('--commit');
const dbArgIndex = process.argv.indexOf('--db');
const EXPECTED_DB = dbArgIndex >= 0 ? process.argv[dbArgIndex + 1] : undefined;

/** `kid:v2:<body>` → `v2`; a legacy blob with no prefix → null. */
const kidOf = (blob: string): string | null => {
    if (!blob.startsWith('kid:')) return null;
    const rest = blob.slice(4);
    const colon = rest.indexOf(':');
    return colon > 0 ? rest.slice(0, colon) : null;
};

interface Tally {
    scanned: number;
    rewrapped: number;
    alreadyCurrent: number;
    failed: { id: string; error: string }[];
}

const newTally = (): Tally => ({ scanned: 0, rewrapped: 0, alreadyCurrent: 0, failed: [] });

/**
 * Decrypt-then-re-encrypt one blob.
 *
 * Returns null when the blob already carries the active kid (nothing to do).
 * Throws when it cannot be decrypted — which almost always means the key that
 * wrote it is not registered in this environment. That is the failure worth
 * catching in a dry run, BEFORE anything is written.
 */
const rewrap = (blob: string): string | null => {
    if (kidOf(blob) === MFA_ENCRYPTION_ACTIVE_KID) return null;
    const plain = decryptSecret(blob);
    const next = encryptSecret(plain);
    // Prove the new blob round-trips before it is ever persisted. An
    // unverified re-encrypt of a TOTP secret is an MFA lockout you don't
    // discover until the user's next login.
    if (decryptSecret(next) !== plain) {
        throw new Error('re-encrypted blob failed verification round-trip');
    }
    return next;
};

const processCollection = async (
    collectionName: string,
    field: string,
    filter: Record<string, unknown>
): Promise<Tally> => {
    const tally = newTally();
    const col = mongoose.connection.collection(collectionName);
    const cursor = col.find(filter).project({ [field]: 1 });

    for await (const doc of cursor) {
        // `field` may be dotted (`slack.bot_token`) — walk it.
        const current = field.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | null)?.[k], doc);
        if (typeof current !== 'string' || current.length === 0) continue;

        tally.scanned += 1;
        const id = String(doc._id);
        try {
            const next = rewrap(current);
            if (next === null) {
                tally.alreadyCurrent += 1;
                continue;
            }
            if (COMMIT) {
                await col.updateOne({ _id: doc._id }, { $set: { [field]: next } });
            }
            tally.rewrapped += 1;
        } catch (err) {
            // Never abort the sweep: during the rotation window BOTH keys are
            // registered, so a row that fails here is still readable by the
            // app. Collect and report — a half-finished pass is recoverable,
            // and the run must not stop at the first bad row.
            tally.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return tally;
};

const report = (label: string, t: Tally): void => {
    logger.info(
        {
            rewrapped: t.rewrapped,
            already_current: t.alreadyCurrent,
            failed: t.failed.length,
            scanned: t.scanned,
        },
        `  ${label}`
    );
    for (const f of t.failed) {
        logger.error({ id: f.id, error: f.error }, `  ${label} — COULD NOT RE-ENCRYPT`);
    }
};

async function main(): Promise<void> {
    if (!MFA_ENCRYPTION_ACTIVE_KID) {
        logger.error(
            {},
            'MFA_ENCRYPTION_ACTIVE_KID is not set. Without it `encryptSecret` writes the ' +
                'LEGACY (kid-less) format, so this script would re-encrypt every blob under ' +
                'the old key and report success. Set it to the new kid first (step 1).'
        );
        process.exit(1);
    }

    await connectDB();
    const dbName = mongoose.connection.db?.databaseName;
    if (!dbName) throw new Error('Database connection has no `databaseName`.');

    if (!EXPECTED_DB) {
        logger.error({ dbName }, 'Pass --db <name> naming the database you intend to rewrite.');
        await disconnectDB();
        process.exit(1);
    }
    if (EXPECTED_DB !== dbName) {
        logger.error(
            { expected: EXPECTED_DB, actual: dbName },
            'MONGO_URI resolves to a DIFFERENT database than --db. Refusing to run.'
        );
        await disconnectDB();
        process.exit(1);
    }

    logger.info(
        { dbName, activeKid: MFA_ENCRYPTION_ACTIVE_KID, mode: COMMIT ? 'COMMIT' : 'DRY RUN' },
        COMMIT ? 'Re-encryption pass — WRITING' : 'Re-encryption pass — dry run, no writes'
    );

    const results: [string, Tally][] = [
        [
            'users.mfa_secret_encrypted',
            await processCollection('users', 'mfa_secret_encrypted', {
                mfa_secret_encrypted: { $nin: [null, ''] },
            }),
        ],
        [
            'system_settings.slack.bot_token',
            await processCollection('system_settings', 'slack.bot_token', {
                'slack.bot_token': { $nin: [null, ''] },
            }),
        ],
        [
            'project_share_links.token_encrypted',
            await processCollection('project_share_links', 'token_encrypted', {
                token_encrypted: { $nin: [null, ''] },
            }),
        ],
    ];

    for (const [label, tally] of results) report(label, tally);

    const totalFailed = results.reduce((n, [, t]) => n + t.failed.length, 0);
    const totalRewrapped = results.reduce((n, [, t]) => n + t.rewrapped, 0);

    if (totalFailed > 0) {
        logger.error(
            { failed: totalFailed },
            'Some blobs could not be decrypted — the key that wrote them is not registered ' +
                'in this environment. DO NOT retire the old key. Fix the env and re-run.'
        );
    } else if (!COMMIT) {
        logger.info(
            { would_rewrap: totalRewrapped },
            'Dry run clean — every blob decrypted and round-tripped. Re-run with --commit.'
        );
    } else {
        logger.info({ rewrapped: totalRewrapped }, 'Done. Verify, then retire the old key (step 3).');
    }

    await disconnectDB();
    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(async (err) => {
    logger.error({ err }, 'Re-encryption pass failed');
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
