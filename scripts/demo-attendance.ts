/**
 * Make attendance look like a working company for the demo window.
 *
 *   npx tsx scripts/demo-attendance.ts             # dry run
 *   npx tsx scripts/demo-attendance.ts --commit
 *
 * Why this is needed: nobody ever checks in on a demo database, so the
 * `attendance_finalizer` cron has been dutifully marking all 15 staff ABSENT
 * every working day. The dashboard headline therefore reads "0 of 15 present ·
 * 0%" and Team attendance shows an empty office.
 *
 * Rules:
 *   - `weekend`, `holiday` and `on_leave` rows are NEVER touched. on_leave in
 *     particular mirrors a real approved leave request, so overwriting it would
 *     contradict the Leaves screen.
 *   - Everything else on a working day becomes `present`, except one person per
 *     day left absent and one on WFH — a company at 100.0% every single day
 *     reads as fake too.
 *   - Assignment is by (day, user) index, not random, so a re-run is identical.
 *   - Today, people are checked IN with no check-out yet, which is what you
 *     want mid-afternoon during a live demo.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const TODAY = new Date().toISOString().slice(0, 10);
/** IST is UTC+5:30; stored times are UTC. */
const istToUtc = (date: string, h: number, m: number): Date =>
    new Date(new Date(`${date}T00:00:00Z`).getTime() + (h * 60 + m - 330) * 60_000);

const PRESERVE = new Set(['weekend', 'holiday', 'on_leave']);

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-attendance.ts');
    const db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}   today: ${TODAY}\n`);

    const staff = await db
        .collection('users')
        .find({ role: { $nin: ['client', 'representative'] }, status: 'active' })
        .toArray();
    const holidays = new Set((await db.collection('holidays').distinct('date')).map(String));

    // Working days across the demo window, ending today.
    const days: string[] = [];
    for (let i = 20; i >= 0; i--) {
        const d = new Date(`${TODAY}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        if (holidays.has(iso)) continue;
        days.push(iso);
    }

    let updated = 0;
    let created = 0;
    let preserved = 0;
    const perDay: string[] = [];

    for (const [di, date] of days.entries()) {
        const isToday = date === TODAY;
        let p = 0;
        let a = 0;
        let w = 0;
        let k = 0;

        for (const [ui, u] of staff.entries()) {
            const existing = await db.collection('attendance_records').findOne({ user_id: u._id, local_date: date });
            if (existing && PRESERVE.has(existing.status as string)) {
                preserved++;
                k++;
                continue;
            }

            // One absentee and one WFH per day, rotating through the roster.
            const slot = (ui + di * 3) % staff.length;
            const absent = slot === 0;
            const wfh = slot === 1;

            if (absent) {
                a++;
                if (COMMIT && !existing)
                    await db.collection('attendance_records').insertOne(baseDoc(u._id, date, 'absent'));
                continue;
            }

            // Staggered arrival so the table doesn't read as generated.
            const inH = 9;
            const inM = [5, 12, 20, 28, 35, 42, 50, 58][ui % 8];
            const checkIn = {
                time: istToUtc(date, inH, inM),
                method: 'manual',
                location_id: null,
                ip: '127.0.0.1',
            };
            const outM = [10, 25, 40, 55, 5, 20, 35, 50][ui % 8];
            const outH = outM < 10 ? 19 : 18;
            const checkOut = isToday
                ? null
                : { time: istToUtc(date, outH, outM), method: 'manual', location_id: null, ip: '127.0.0.1' };
            const worked = checkOut
                ? Math.round((checkOut.time.getTime() - checkIn.time.getTime()) / 60_000) - 45
                : null;

            p++;
            if (wfh) w++;
            const doc = {
                ...baseDoc(u._id, date, 'present'),
                segments: [{ check_in: checkIn, check_out: checkOut, breaks: [] }],
                check_in: checkIn,
                check_out: checkOut,
                total_worked_minutes: worked,
                total_break_minutes: checkOut ? 45 : 0,
                break_minutes_by_type: { lunch: checkOut ? 45 : 0, tea: 0, other: 0 },
                overtime_minutes: worked && worked > 510 ? worked - 510 : 0,
                wfh,
            };

            if (COMMIT) {
                if (existing) await db.collection('attendance_records').updateOne({ _id: existing._id }, { $set: doc });
                else await db.collection('attendance_records').insertOne(doc);
            }
            if (existing) updated++;
            else created++;
        }
        perDay.push(
            `${date}  present=${p} (wfh ${w})  absent=${a}  preserved=${k}${isToday ? '   ← today, still checked in' : ''}`
        );
    }

    console.log(perDay.join('\n'));
    console.log(`\nupdated=${updated}  created=${created}  preserved(weekend/holiday/on_leave)=${preserved}`);
    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing written.');
    await mongoose.disconnect();
};

const baseDoc = (userId: unknown, date: string, status: string): Record<string, unknown> => ({
    user_id: userId,
    local_date: date,
    segments: [],
    check_in: null,
    check_out: null,
    total_worked_minutes: null,
    overtime_minutes: 0,
    total_break_minutes: 0,
    break_minutes_by_type: { lunch: 0, tea: 0, other: 0 },
    status,
    flagged_for_correction: false,
    wfh: false,
    notes: '',
    last_corrected_by: null,
    last_corrected_at: null,
    comp_off_accrued: false,
    created_at: new Date(`${date}T12:00:00Z`),
    updated_at: new Date(`${date}T12:00:00Z`),
});

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
