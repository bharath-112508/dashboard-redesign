/**
 * DEMO attendance seeder — sets TODAY's (IST) attendance for active internal
 * staff to a realistic mix: most present (on-time, in progress), a few late, a
 * few not checked in. Backdates morning check-in times (the live check-in API
 * would stamp "now", which is past the late threshold). Idempotent: overwrites
 * today's records; removes records for the "not checked in" set.
 *
 * Run: npx tsx scripts/dev-demo-attendance.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';
import { User } from '../src/models/user.model.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { getOrInitSettings } from '../src/services/settings.service.js';

type State = 'present' | 'late' | 'absent';

const at = (today: string, minuteOfDay: number): Date => {
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mm = String(minuteOfDay % 60).padStart(2, '0');
    return dayjs.tz(`${today} ${hh}:${mm}`, DEFAULT_TIMEZONE).toDate();
};

async function main() {
    await connectDB();
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const settings = await getOrInitSettings();
    const [sh, sm] = String(settings.work_schedule?.start_time ?? '11:00').split(':').map(Number);
    const startMin = sh * 60 + (sm || 0); // e.g. 11:00 -> 660

    const users = await User.find({ status: 'active', role: { $ne: 'client' } })
        .select('full_name email role')
        .lean<{ _id: any; full_name: string; email: string; role: string }[]>();

    // Admin (the demo presenter) is always present on-time. Distribute the rest.
    const admin = users.find((u) => u.role === 'admin');
    const rest = users.filter((u) => u.role !== 'admin').sort((a, b) => a.email.localeCompare(b.email));

    // Deterministic, spread-out distribution across the non-admin staff.
    const absentIdx = new Set([0, 4, 8]);
    const lateIdx = new Set([2, 5, 9]);
    const stateFor = (i: number): State => (absentIdx.has(i) ? 'absent' : lateIdx.has(i) ? 'late' : 'present');

    // On-time check-ins cluster around the start (all within the 10-min grace);
    // late check-ins land 30-80 min after start.
    const PRESENT_OFFSETS = [-9, -4, 1, 6, 9, -6, 3]; // minutes from start (<= +10 grace)
    const LATE_OFFSETS = [34, 51, 78];

    const plan: { user: (typeof users)[number]; state: State; inMin?: number }[] = [];
    if (admin) plan.push({ user: admin, state: 'present', inMin: startMin - 5 });
    let pIdx = 0;
    let lIdx = 0;
    rest.forEach((u, i) => {
        const state = stateFor(i);
        if (state === 'present') plan.push({ user: u, state, inMin: startMin + PRESENT_OFFSETS[pIdx++ % PRESENT_OFFSETS.length] });
        else if (state === 'late') plan.push({ user: u, state, inMin: startMin + LATE_OFFSETS[lIdx++ % LATE_OFFSETS.length] });
        else plan.push({ user: u, state });
    });

    let present = 0, late = 0, absent = 0;
    for (const p of plan) {
        if (p.state === 'absent') {
            await AttendanceRecord.deleteOne({ user_id: p.user._id, local_date: today });
            absent++;
            console.log(`  ${p.user.full_name.padEnd(20)} ${p.user.role.padEnd(10)} NOT CHECKED IN`);
            continue;
        }
        const punch = { time: at(today, p.inMin!), method: 'manual' as const, location_id: null, ip: '' };
        const doc = {
            user_id: p.user._id,
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
        };
        await AttendanceRecord.findOneAndUpdate({ user_id: p.user._id, local_date: today }, doc, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        });
        const hh = String(Math.floor(p.inMin! / 60)).padStart(2, '0');
        const mm = String(p.inMin! % 60).padStart(2, '0');
        if (p.state === 'late') late++; else present++;
        console.log(`  ${p.user.full_name.padEnd(20)} ${p.user.role.padEnd(10)} in ${hh}:${mm} ${p.state === 'late' ? 'LATE' : 'present'} (in progress)`);
    }

    console.log(`\nTotals for ${today}: present(on-time) ${present} · late ${late} · not-checked-in ${absent}\n`);
    await disconnectDB();
}

main().catch(async (e) => {
    console.error(e);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
