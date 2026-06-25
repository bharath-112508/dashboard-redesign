/**
 * Make Karthik a safe Today-page demo persona: present (on-time, in progress)
 * for today. Run: npx tsx scripts/dev-demo-karthik.ts
 * Then `npx tsx scripts/dev-demo-topup.ts` adds his today timesheet.
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';
import { User } from '../src/models/user.model.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { getOrInitSettings } from '../src/services/settings.service.js';

async function main() {
    await connectDB();
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const settings = await getOrInitSettings();
    const [sh, sm] = String(settings.work_schedule?.start_time ?? '11:00').split(':').map(Number);
    const inMin = sh * 60 + (sm || 0) - 2; // 2 min before start → on-time

    const k = await User.findOne({ email: 'karthik@viljetech.com' }).select('_id full_name').lean<{ _id: any; full_name: string }>();
    if (!k) throw new Error('Karthik not found');

    const hh = String(Math.floor(inMin / 60)).padStart(2, '0');
    const mm = String(inMin % 60).padStart(2, '0');
    const punch = { time: dayjs.tz(`${today} ${hh}:${mm}`, DEFAULT_TIMEZONE).toDate(), method: 'manual' as const, location_id: null, ip: '' };

    await AttendanceRecord.findOneAndUpdate(
        { user_id: k._id, local_date: today },
        {
            user_id: k._id,
            local_date: today,
            segments: [{ check_in: punch, check_out: null, breaks: [] }],
            check_in: punch,
            check_out: null,
            total_worked_minutes: null,
            overtime_minutes: 0,
            total_break_minutes: 0,
            break_minutes_by_type: { lunch: 0, tea: 0, other: 0 },
            status: 'present' as const,
            flagged_for_correction: false,
            wfh: false,
            notes: '',
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    console.log(`${k.full_name} → present, checked in ${hh}:${mm} (in progress) for ${today}`);
    await disconnectDB();
}

main().catch(async (e) => {
    console.error(e);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
