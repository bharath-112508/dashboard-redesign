/**
 * Smoke-test helper for `scripts/smoke-notifications.sh`.
 *
 * Wipes the dispatch-relevant collections (notifications + the leave / comp-off
 * rows that smoke-notifications.sh creates) for the smoke users so the suite
 * is fully rerunnable from a clean slate. We deliberately keep the user rows
 * intact — `smoke-reset-users.ts` already takes care of those when the master
 * runner (`smoke-all.sh`) needs a hard reset.
 *
 * Idempotent: safe to run when no rows exist.
 *
 * Run:  npx tsx scripts/smoke-notifications-prep.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { Notification } from '../src/models/notification.model.js';
import { LeaveRequest } from '../src/models/leave-request.model.js';

const SMOKE_NOTIF_EMAILS = [
    'smoke@example.com',
    'smoke-mgr@example.com',
    'smoke-emp@example.com',
    'smoke-emp2@example.com',
];

async function main() {
    await connectDB();
    const users = await User.find({ email: { $in: SMOKE_NOTIF_EMAILS } }).select('_id email');
    if (users.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No smoke-notifications users present yet — nothing to wipe.');
        await disconnectDB();
        return;
    }

    const ids = users.map((u) => u._id);
    const [notif, leaves] = await Promise.all([
        Notification.deleteMany({ user_id: { $in: ids } }),
        // Cancel pending/approved leaves rather than hard-deleting so the
        // ledger trail stays consistent. Hard delete is fine here because
        // smoke runs are throwaway and the model has no soft-delete contract.
        LeaveRequest.deleteMany({ user_id: { $in: ids } }),
    ]);

    // eslint-disable-next-line no-console
    console.log(
        `Wiped ${notif.deletedCount ?? 0} notification(s) and ${leaves.deletedCount ?? 0} leave_request(s) ` +
            `for ${users.length} smoke user(s).`
    );
    await disconnectDB();
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
