/**
 * DEMO top-up — fills two gaps for the demo:
 *   1. TODAY's timesheet entries for everyone checked in today (so the Today
 *      page + dashboard "Today" tab show logged hours).
 *   2. One office location (with a QR check-in token) if none exists.
 * Idempotent: skips a user who already has entries for today; skips office
 * creation if any location exists.
 *
 * Run: npx tsx scripts/dev-demo-topup.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';
import { User } from '../src/models/user.model.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { Task } from '../src/models/task.model.js';
import { TimesheetEntry } from '../src/models/timesheet-entry.model.js';
import { OfficeLocation } from '../src/models/office-location.model.js';
import { generateQrToken } from '../src/utils/office-location-qr.js';

const total = (h: number, m: number) => h * 60 + m;

async function main() {
    await connectDB();
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const admin = await User.findOne({ role: 'admin' }).select('_id').lean<{ _id: any }>();

    // ── 1. Office location (+ QR token) ──────────────────────────────────────
    const officeCount = await OfficeLocation.countDocuments({});
    if (officeCount === 0 && admin) {
        const office = await OfficeLocation.create({
            name: 'Viljetech HQ — Bengaluru',
            address: '4th Floor, Prestige Tech Park, Outer Ring Road, Bengaluru 560103',
            qr_code_token: generateQrToken(),
            is_active: true,
            created_by: admin._id,
        });
        console.log(`Office location created: "${office.name}" (QR token issued)`);
    } else {
        console.log(`Office locations: ${officeCount} already exist — skipped`);
    }

    // ── 2. Today's timesheets for checked-in users ───────────────────────────
    const recs = await AttendanceRecord.find({ local_date: today, check_in: { $ne: null } })
        .select('user_id')
        .lean<{ user_id: any }[]>();
    const checkedInIds = recs.map((r) => r.user_id);
    console.log(`\nChecked-in users today: ${checkedInIds.length}`);

    let created = 0;
    let userIdx = 0;
    for (const uid of checkedInIds) {
        const existing = await TimesheetEntry.countDocuments({ user_id: uid, local_date: today });
        if (existing > 0) {
            console.log(`  ${String(uid)} — ${existing} entries already today, skipped`);
            continue;
        }
        const user = await User.findById(uid).select('full_name').lean<{ full_name: string }>();
        const tasks = await Task.find({ primary_assignee_id: uid })
            .select('_id project_id title')
            .limit(3)
            .lean<{ _id: any; project_id: any; title: string }[]>();

        const entries: Record<string, unknown>[] = [];
        const base = (e: Partial<Record<string, unknown>>) => ({
            user_id: uid,
            local_date: today,
            sprint_id: null,
            general_category: null,
            billable_hours: 0,
            billable_minutes: 0,
            non_billable_hours: 0,
            non_billable_minutes: 0,
            last_edited_by: uid,
            last_edited_at: new Date(),
            ...e,
        });

        if (tasks.length >= 2) {
            const bm = userIdx % 2 ? 30 : 0; // vary a little
            entries.push(
                base({
                    entry_type: 'task_linked',
                    project_id: tasks[0].project_id,
                    task_id: tasks[0]._id,
                    billable_hours: 3,
                    billable_minutes: bm,
                    billable_total_minutes: total(3, bm),
                    non_billable_total_minutes: 0,
                    total_minutes: total(3, bm),
                    description: `Worked on ${tasks[0].title}`,
                }),
                base({
                    entry_type: 'task_linked',
                    project_id: tasks[1].project_id,
                    task_id: tasks[1]._id,
                    billable_hours: 2,
                    billable_total_minutes: total(2, 0),
                    non_billable_total_minutes: 0,
                    total_minutes: total(2, 0),
                    description: `Progress on ${tasks[1].title}`,
                }),
            );
        } else if (tasks.length === 1) {
            entries.push(
                base({
                    entry_type: 'task_linked',
                    project_id: tasks[0].project_id,
                    task_id: tasks[0]._id,
                    billable_hours: 4,
                    billable_total_minutes: total(4, 0),
                    non_billable_total_minutes: 0,
                    total_minutes: total(4, 0),
                    description: `Worked on ${tasks[0].title}`,
                }),
            );
        } else {
            entries.push(
                base({
                    entry_type: 'general',
                    project_id: null,
                    task_id: null,
                    general_category: 'Team sync & planning',
                    non_billable_hours: 3,
                    non_billable_total_minutes: total(3, 0),
                    total_minutes: total(3, 0),
                    description: 'Stand-up, planning and internal coordination',
                }),
            );
        }

        await TimesheetEntry.insertMany(entries);
        created += entries.length;
        const mins = entries.reduce((a, e) => a + (e.total_minutes as number), 0);
        console.log(`  ${(user?.full_name ?? String(uid)).padEnd(20)} +${entries.length} entries (${Math.floor(mins / 60)}h ${mins % 60}m)`);
        userIdx++;
    }

    console.log(`\nCreated ${created} timesheet entries for ${today}.\n`);
    await disconnectDB();
}

main().catch(async (e) => {
    console.error(e);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
