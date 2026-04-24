/**
 * Smoke-test helper — wipes today's attendance + correction rows for the
 * given user emails so `smoke-attendance.sh` is fully rerunnable in a
 * single working day. NOT for production.
 *
 * Run:  npx tsx scripts/smoke-reset-attendance.ts smoke-emp@example.com smoke-emp2@example.com
 *
 * If no emails are passed it defaults to the standard smoke trio. The script
 * resolves emails to `_id`s, deletes today's `attendance_records` rows for
 * those users, and cascades into any `attendance_correction_requests`
 * pointing at the deleted record ids. It deliberately does NOT touch other
 * days so historic test data stays around.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { AttendanceCorrectionRequest } from '../src/models/attendance-correction-request.model.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_EMAILS = [
    'smoke-emp@example.com',
    'smoke-emp2@example.com',
    'smoke-mgr@example.com',
];

async function main() {
    const emails = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_EMAILS;

    await connectDB();
    const users = await User.find({ email: { $in: emails } }).select({ _id: 1, email: 1 });
    if (users.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No matching users — nothing to reset');
        await disconnectDB();
        return;
    }

    const today = dayjs().tz('Asia/Kolkata').format('YYYY-MM-DD');
    const userIds = users.map((u) => u._id);

    const records = await AttendanceRecord.find({
        user_id: { $in: userIds },
        local_date: today,
    }).select({ _id: 1 });
    const recordIds = records.map((r) => r._id);

    let deletedCorrections = 0;
    if (recordIds.length > 0) {
        const cor = await AttendanceCorrectionRequest.deleteMany({
            attendance_record_id: { $in: recordIds },
        });
        deletedCorrections = cor.deletedCount ?? 0;
    }
    const att = await AttendanceRecord.deleteMany({ _id: { $in: recordIds } });

    // eslint-disable-next-line no-console
    console.log(
        `Reset complete — emails=${users.map((u) => u.email).join(',')} date=${today} attendance_deleted=${att.deletedCount ?? 0} corrections_deleted=${deletedCorrections}`
    );
    await disconnectDB();
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
