/**
 * Smoke-test helper — clears every user except the seed admin and resets
 * the seed admin's lockout + role. NOT for production.
 *
 * Run:  npx tsx scripts/smoke-reset-users.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { assertSafeDb } from './_safe-db.js';
import { User } from '../src/models/user.model.js';
import { RefreshToken } from '../src/models/refresh-token.model.js';
import { PasswordResetToken } from '../src/models/password-reset-token.model.js';

const SEED_EMAIL = 'smoke@example.com';

async function main() {
    await connectDB();
    // The next line deletes every user but one. "NOT for production" in the
    // header was the only thing standing between `npm run smoke` and an empty
    // production user table.
    assertSafeDb('smoke-reset-users.ts');
    await User.deleteMany({ email: { $ne: SEED_EMAIL } });
    await RefreshToken.deleteMany({});
    await PasswordResetToken.deleteMany({});
    await User.updateOne(
        { email: SEED_EMAIL },
        {
            $set: {
                status: 'active',
                deactivated_at: null,
                locked_until: null,
                failed_login_attempts: 0,
                role: 'admin',
                mfa_enabled: false,
                mfa_secret_encrypted: null,
                mfa_backup_codes_hashed: [],
            },
        }
    );

    console.log('Reset complete');
    await disconnectDB();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
