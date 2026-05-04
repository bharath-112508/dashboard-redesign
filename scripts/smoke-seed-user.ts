/**
 * One-off smoke seeder — creates / resets a single admin user for manual
 * smoke testing. NOT for production. Remove after Step 3 introduces a real
 * admin-bootstrap flow.
 *
 * Run:  npx tsx scripts/smoke-seed-user.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { hashPassword } from '../src/utils/password.js';
import { ROLES } from '../src/constants/roles.js';

const EMAIL = 'smoke@example.com';
const PASSWORD = 'SmokeA@123!';

async function main() {
    await connectDB();
    const password_hash = await hashPassword(PASSWORD);
    await User.updateOne(
        { email: EMAIL },
        {
            $set: {
                email: EMAIL,
                password_hash,
                full_name: 'Smoke Admin',
                role: ROLES.ADMIN,
                status: 'active',
                timezone: 'Asia/Kolkata',
                mfa_enabled: false,
                failed_login_attempts: 0,
                locked_until: null,
            },
        },
        { upsert: true }
    );

    console.log(`Seeded ${EMAIL} / ${PASSWORD}`);
    await disconnectDB();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
