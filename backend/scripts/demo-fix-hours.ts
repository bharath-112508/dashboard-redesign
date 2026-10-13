/**
 * Spread impossible working days across the calendar. Moves only — never
 * deletes, never trims.
 *
 *   npx tsx scripts/demo-fix-hours.ts             # dry run
 *   npx tsx scripts/demo-fix-hours.ts --commit
 *
 * Two causes of >10h days:
 *   - the seed itself (Sneha has a 10h and a 14h entry on one day, plus a
 *     deliberate "Crunch day — 16h billable" that exists to demonstrate the
 *     daily-threshold warning), and
 *   - `demo-fill-recent`, which relocated entries off holidays onto the nearest
 *     working day without checking what was already logged there.
 *
 * Rules, in order of importance:
 *   1. Nothing is deleted or shortened. Every logged hour survives; only its
 *      date moves. An earlier version of this script would have dropped three
 *      entries it had misclassified as its own filler — they were seed content.
 *   2. Candidate target days are ALL working days in the window, not just days
 *      the person already logged. That was the bug that made deletion look
 *      necessary: with no empty days considered there was nowhere to move to.
 *   3. The largest entry on a day stays put. It is the intentional one, and a
 *      single big entry alone on a day is a legitimate crunch day.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const CAP_MINUTES = 10 * 60;
const WINDOW_DAYS = 28;

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-fix-hours.ts');
    const db = mongoose.connection.db!;
    const today = new Date().toISOString().slice(0, 10);
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}   cap: ${CAP_MINUTES / 60}h/day\n`);

    const holidays = new Set((await db.collection('holidays').distinct('date')).map(String));
    const workdays: string[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        if (holidays.has(iso)) continue;
        workdays.push(iso);
    }

    let moved = 0;
    let stuck = 0;

    for (const uid of await db.collection('timesheet_entries').distinct('user_id')) {
        const user = await db.collection('users').findOne({ _id: uid });
        const entries = await db.collection('timesheet_entries').find({ user_id: uid }).toArray();

        // Only days this person was actually at work can receive hours. Without
        // this the surplus lands on days with no attendance record at all, and
        // Timesheets contradicts Attendance again — the very thing this whole
        // pass exists to fix.
        const presentDays = new Set(
            await db.collection('attendance_records').distinct('local_date', { user_id: uid, status: 'present' })
        );
        const candidates = workdays.filter((d) => presentDays.has(d));

        const byDay = new Map<string, typeof entries>();
        for (const w of workdays) byDay.set(w, []);
        for (const e of entries) byDay.set(e.local_date as string, [...(byDay.get(e.local_date as string) ?? []), e]);

        const total = (d: string): number =>
            (byDay.get(d) ?? []).reduce((s, e) => s + ((e.total_minutes as number) ?? 0), 0);

        for (const day of [...byDay.keys()].sort()) {
            while (total(day) > CAP_MINUTES && (byDay.get(day) ?? []).length > 1) {
                // Smallest first; the biggest entry is the intentional one.
                const rows = [...(byDay.get(day) ?? [])].sort(
                    (a, b) => ((a.total_minutes as number) ?? 0) - ((b.total_minutes as number) ?? 0)
                );
                const e = rows[0];
                const mins = (e.total_minutes as number) ?? 0;

                const target = candidates
                    .filter((d) => d !== day && total(d) + mins <= CAP_MINUTES)
                    .sort((a, b) => total(a) - total(b))[0];
                if (!target) {
                    stuck++;
                    console.log(
                        `stuck ${(user?.full_name ?? '?').padEnd(18)} ${day} at ${(total(day) / 60).toFixed(1)}h — no day with room, left as is`
                    );
                    break;
                }

                byDay.set(day, rows.slice(1));
                byDay.set(target, [...(byDay.get(target) ?? []), { ...e, local_date: target }]);
                moved++;
                console.log(
                    `move  ${(user?.full_name ?? '?').padEnd(18)} ${(mins / 60).toFixed(1)}h  ${day} → ${target}`
                );
                if (COMMIT)
                    await db
                        .collection('timesheet_entries')
                        .updateOne({ _id: e._id }, { $set: { local_date: target } });
            }
        }
    }

    console.log(`\nmoved ${moved} entr(ies); ${stuck} day(s) left over cap (nothing deleted or shortened)`);
    console.log(COMMIT ? 'Applied.' : 'Dry run — nothing written.');
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
