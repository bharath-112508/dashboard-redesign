/**
 * Smoke-test helper for `scripts/smoke-leaves.sh`.
 *
 * Step 10 introduces a second smoke employee (`smoke-emp2@example.com`)
 * that the rest of the smoke suite doesn't use. When the master runner
 * (`scripts/smoke-all.sh`) executes us, `smoke-reset-users.ts` has
 * already wiped all non-admin users, so lazy-create works cleanly. But
 * for standalone runs (`bash scripts/smoke-leaves.sh`), an `smoke-emp2`
 * left over from a prior run with a stale password would prevent login.
 *
 * This script deletes the leave-smoke-specific user so the bash suite's
 * lazy-create step recreates them with the smoke passwords. Idempotent —
 * safe to run when no rows exist.
 *
 * Run:  npx tsx scripts/smoke-leaves-prep.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { RefreshToken } from '../src/models/refresh-token.model.js';
import { LeaveBalance } from '../src/models/leave-balance.model.js';
import { LeaveRequest } from '../src/models/leave-request.model.js';
import { CompOffLedger } from '../src/models/comp-off-ledger.model.js';
import { SlMonthlyForfeiture } from '../src/models/sl-monthly-forfeiture.model.js';

const SMOKE_LEAVE_EMAILS = ['smoke-emp2@example.com'];

async function main() {
    await connectDB();
    const users = await User.find({ email: { $in: SMOKE_LEAVE_EMAILS } }).select('_id email');
    if (users.length > 0) {
        const ids = users.map((u) => u._id);
        await Promise.all([
            LeaveBalance.deleteMany({ user_id: { $in: ids } }),
            LeaveRequest.deleteMany({ user_id: { $in: ids } }),
            CompOffLedger.deleteMany({ user_id: { $in: ids } }),
            SlMonthlyForfeiture.deleteMany({ user_id: { $in: ids } }),
            RefreshToken.deleteMany({ user_id: { $in: ids } }),
        ]);
        await User.deleteMany({ _id: { $in: ids } });
        // eslint-disable-next-line no-console
        console.log(`Removed ${users.length} stale smoke-leaves user(s): ${users.map((u) => u.email).join(', ')}`);
    } else {
        // eslint-disable-next-line no-console
        console.log('No stale smoke-leaves users to remove.');
    }
    await disconnectDB();
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
