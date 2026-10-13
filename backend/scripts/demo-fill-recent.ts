/**
 * Fill the recent working days so the modules agree with each other.
 *
 *   npx tsx scripts/demo-fill-recent.ts             # dry run
 *   npx tsx scripts/demo-fill-recent.ts --commit
 *
 * Three inconsistencies this closes, all of them visible on screen:
 *
 *  1. TIMESHEETS vs ATTENDANCE. Last week 13 people were marked present each
 *     day and 3 of them logged any time. Attendance and Timesheets are the two
 *     screens most likely to be opened side by side, so they must agree:
 *     everyone recorded present now logs a day, and nobody absent or on leave
 *     does.
 *  2. DEAD ACTIVITY FEEDS. `task_activities` was empty on nearly every day for
 *     two weeks — no task had moved at all. Boards and the activity sidebar
 *     render as frozen.
 *  3. WORK LOGGED ON HOLIDAYS. 29 Jul and 4 Aug are holidays with attendance
 *     showing a closed office, yet 9 people had logged hours. Those entries are
 *     MOVED to the nearest working day rather than deleted — the hours were
 *     real, only the date contradicted the calendar.
 *
 * Hours are drawn from a per-person deterministic pattern, not random, so a
 * re-run produces the same dataset and nobody logs a suspicious 8.00h every
 * single day.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const LOOKBACK_DAYS = 21;

type Id = mongoose.Types.ObjectId;

/** Non-billable work still gets logged; these are the categories in use. */
const GENERAL = ['Project management', 'Planning & 1:1s', 'Documentation & certificates'];

/** Plausible day shapes: [billable, non-billable]. Indexed per person/day. */
const SHAPES: Array<[number, number]> = [
    [7, 1],
    [6, 2],
    [8, 0],
    [6, 1],
    [7, 2],
    [5, 2],
    [8, 1],
    [6, 0],
];

const NOTES_TASK = [
    'Implementation and unit tests',
    'Code review feedback and fixes',
    'Pairing session, then wiring the integration',
    'Debugging the edge case reported yesterday',
    'Finishing the happy path, error handling next',
    'Refactor plus test coverage for the new branch',
    'Manual testing against staging data',
    'Follow-up fixes after review',
];
const NOTES_GENERAL = [
    'Standup, sprint planning and backlog grooming',
    'Delivery review and client check-in',
    'Interviews and team 1:1s',
    'Release coordination and handover notes',
    'Documentation updates and onboarding material',
];

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-fill-recent.ts');
    const db = mongoose.connection.db!;
    const today = new Date().toISOString().slice(0, 10);
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}   today: ${today}\n`);

    const staff = await db
        .collection('users')
        .find({ role: { $nin: ['client', 'representative'] }, status: 'active' })
        .toArray();
    const holidays = new Set((await db.collection('holidays').distinct('date')).map(String));

    const workdays: string[] = [];
    for (let i = LOOKBACK_DAYS - 1; i >= 0; i--) {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        if (holidays.has(iso)) continue;
        workdays.push(iso);
    }

    // ---- 3. move holiday/weekend timesheets onto a real working day --------
    const misplaced = await db
        .collection('timesheet_entries')
        .find({ local_date: { $nin: workdays, $gte: workdays[0] } })
        .toArray();
    let moved = 0;
    for (const e of misplaced) {
        // Nearest earlier working day; falls back to the first in range.
        const target = [...workdays].reverse().find((w) => w < (e.local_date as string)) ?? workdays[0];
        moved++;
        if (COMMIT)
            await db.collection('timesheet_entries').updateOne({ _id: e._id }, { $set: { local_date: target } });
    }
    console.log(`3. moved ${moved} timesheet entr(ies) off holidays/weekends onto working days`);

    // ---- per-person task pools --------------------------------------------
    const pool = new Map<string, Array<{ _id: Id; title: string; project_id: Id }>>();
    for (const u of staff) {
        const mine = await db
            .collection('tasks')
            .find({ assignee_ids: u._id }, { projection: { _id: 1, title: 1, project_id: 1 } })
            .toArray();
        pool.set(String(u._id), mine as Array<{ _id: Id; title: string; project_id: Id }>);
    }

    // ---- 1. one logged day per person per day they were present -----------
    let added = 0;
    const perDay: string[] = [];
    for (const [di, date] of workdays.entries()) {
        let n = 0;
        for (const [ui, u] of staff.entries()) {
            const att = await db.collection('attendance_records').findOne({ user_id: u._id, local_date: date });
            // Only people who actually turned up log a day.
            if (!att || att.status !== 'present') continue;
            const already = await db
                .collection('timesheet_entries')
                .countDocuments({ user_id: u._id, local_date: date });
            if (already > 0) continue;

            const [billable, nonBillable] = SHAPES[(ui + di) % SHAPES.length];
            const mine = pool.get(String(u._id)) ?? [];
            const task = mine.length ? mine[(di + ui) % mine.length] : null;

            n++;
            added++;
            if (COMMIT)
                await db.collection('timesheet_entries').insertOne({
                    user_id: u._id,
                    local_date: date,
                    entry_type: task ? 'task_linked' : 'general',
                    project_id: task ? task.project_id : null,
                    sprint_id: null,
                    task_id: task ? task._id : null,
                    general_category: task ? null : GENERAL[(ui + di) % GENERAL.length],
                    billable_hours: billable,
                    billable_minutes: 0,
                    billable_total_minutes: billable * 60,
                    non_billable_hours: nonBillable,
                    non_billable_minutes: 0,
                    non_billable_total_minutes: nonBillable * 60,
                    total_minutes: (billable + nonBillable) * 60,
                    description: task
                        ? `${task.title} — ${NOTES_TASK[(di + ui) % NOTES_TASK.length]}`
                        : NOTES_GENERAL[(ui + di) % NOTES_GENERAL.length],
                    last_edited_by: u._id,
                    last_edited_at: new Date(`${date}T13:00:00Z`),
                    created_at: new Date(`${date}T13:00:00Z`),
                    updated_at: new Date(`${date}T13:00:00Z`),
                });
        }
        perDay.push(`   ${date}  +${n}`);
    }
    console.log(`1. added ${added} timesheet entries so every present employee logged a day`);
    console.log(perDay.join('\n'));

    // ---- 2. task activity across the last two weeks -----------------------
    // Reconstructed from where each task actually sits now, so the feed tells a
    // story that ends at the task's real current status.
    const CHAIN: Record<string, string[]> = {
        in_progress: ['to_do', 'in_progress'],
        review: ['to_do', 'in_progress', 'review'],
        done: ['to_do', 'in_progress', 'review', 'done'],
    };
    let acts = 0;
    let respread = 0;
    const tasks = await db.collection('tasks').find({}).toArray();
    const W = workdays.length;

    for (const [ti, t] of tasks.entries()) {
        const own = await db.collection('task_activities').find({ task_id: t._id }).sort({ created_at: 1 }).toArray();

        if (own.length > 0) {
            // Re-date rather than add: 35 of 40 rows sat on one day three weeks
            // ago. Appending a second to_do→in_progress would tell the story
            // twice; moving them tells it once, recently. Order is preserved,
            // so "created" stays first and the newest transition stays last.
            for (const [i, a] of own.entries()) {
                const idx = own.length === 1 ? 0 : Math.round((i / (own.length - 1)) * (W - 1));
                const day = workdays[Math.min(idx, W - 1)];
                const when = new Date(`${day}T${String(9 + (i % 8)).padStart(2, '0')}:${(ti * 7 + i * 11) % 60}:00Z`);
                respread++;
                if (COMMIT)
                    await db
                        .collection('task_activities')
                        .updateOne({ _id: a._id }, { $set: { created_at: when, updated_at: when } });
            }
            continue;
        }

        // Tasks created by this demo prep have no history at all — give them one.
        const chain = CHAIN[t.status as string] ?? ['to_do'];
        const actor = (t.primary_assignee_id ?? t.created_by) as Id;
        const startIdx = Math.max(0, W - 1 - chain.length * 2 - (ti % 3));
        acts++;
        if (COMMIT)
            await db.collection('task_activities').insertOne({
                task_id: t._id,
                actor_id: t.created_by,
                activity_type: 'created',
                from_value: null,
                to_value: { title: t.title, status: 'to_do' },
                created_at: new Date(`${workdays[startIdx]}T09:${(ti * 7) % 60}:00Z`),
                updated_at: new Date(`${workdays[startIdx]}T09:${(ti * 7) % 60}:00Z`),
            });
        for (let s = 1; s < chain.length; s++) {
            const day = workdays[Math.min(W - 1, startIdx + s * 2)];
            const when = new Date(`${day}T${String(10 + s).padStart(2, '0')}:${(ti * 7) % 60}:00Z`);
            acts++;
            if (COMMIT)
                await db.collection('task_activities').insertOne({
                    task_id: t._id,
                    actor_id: actor,
                    activity_type: 'status_changed',
                    from_value: { status: chain[s - 1] },
                    to_value: { status: chain[s] },
                    created_at: when,
                    updated_at: when,
                });
        }
    }
    console.log(
        `2. re-dated ${respread} existing activity rows across the window, added ${acts} for tasks with no history`
    );

    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing written.');
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
