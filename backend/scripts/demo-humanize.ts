/**
 * Pre-demo data-quality pass. Run AFTER demo-prune.ts.
 *
 *   npx tsx scripts/demo-humanize.ts             # dry run
 *   npx tsx scripts/demo-humanize.ts --commit    # apply
 *
 * Fixes the things that make seeded data read as seeded:
 *   A  leftover test rows
 *   B  Nordmark's 13 client contacts → 4 properly-named, all rostered
 *   C  Aurora's placeholder contacts + a typo'd email domain
 *   D  the timeline: timesheets stopped 14 days ago and the "active" sprint
 *      had already ended, so the current week rendered empty
 *   E  staff with no work at all
 *   F  every task authored by admin@viljetech.com
 *
 * The date shift is +14 days — exactly two weeks, so every weekday alignment
 * is preserved and Monday stays Monday. Anything that shifts must shift by the
 * same amount or the internal consistency it is meant to fix gets worse.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Document } from 'mongodb';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const SHIFT_DAYS = 14;

type Id = mongoose.Types.ObjectId;

let db!: mongoose.mongo.Db;
const log: string[] = [];
const note = (s: string): void => {
    log.push(s);
};

const shiftIso = (iso: string, days: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

/** Staff ids, resolved by email so a reseed can't silently retarget them. */
const staff: Record<string, Id> = {};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-humanize.ts');
    db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN'}\n`);

    for (const u of await db
        .collection('users')
        .find({ role: { $nin: ['client', 'representative'] } })
        .toArray())
        staff[u.email as string] = u._id as Id;

    const afs = (await db.collection('projects').findOne({ code: 'AFS' }))!;
    const nfd = (await db.collection('projects').findOne({ code: 'NFD' }))!;

    // ================= A. leftover test rows ==============================
    const junk = await db
        .collection('tasks')
        .find({ title: { $in: [/^test /i, /^sample/i, /^\s*$/] } })
        .toArray();
    if (junk.length) {
        note(`A. delete ${junk.length} test task(s): ${junk.map((t) => t.title).join(', ')}`);
        if (COMMIT) {
            const ids = junk.map((t) => t._id);
            await db.collection('task_comments').deleteMany({ task_id: { $in: ids } });
            await db.collection('task_activities').deleteMany({ task_id: { $in: ids } });
            await db.collection('task_attachments').deleteMany({ task_id: { $in: ids } });
            await db.collection('timesheet_entries').deleteMany({ task_id: { $in: ids } });
            await db.collection('tasks').deleteMany({ _id: { $in: ids } });
        }
    }

    // ================= B. Nordmark client contacts ========================
    const nord = (await db.collection('companies').findOne({ name: 'Nordmark Logistics AS' }))!;
    const KEEP_NORD = [
        'henrik@viljetech.com',
        'ingrid@nordmark.example',
        'lars@nordmark.example',
        'marit@nordmark.example',
    ];
    const dropNord = await db
        .collection('users')
        .find({ 'client_profile.company_id': nord._id, email: { $nin: KEEP_NORD } })
        .toArray();
    if (dropNord.length) {
        note(
            `B. delete ${dropNord.length} Nordmark placeholder contact(s): ${dropNord.map((u) => u.email).join(', ')}`
        );
        if (COMMIT) {
            const ids = dropNord.map((u) => u._id);
            for (const c of ['refresh_tokens', 'notifications', 'push_subscriptions', 'leave_balances'])
                await db.collection(c).deleteMany({ user_id: { $in: ids } });
            await db.collection('users').deleteMany({ _id: { $in: ids } });
            await db.collection('projects').updateMany({}, { $pull: { representative_ids: { $in: ids } } } as Document);
            await db.collection('project_share_links').deleteMany({ owner_client_id: { $in: ids } });
        }
    }

    // ================= C. contact names + the typo'd domain ===============
    // Every one of these is a `.example` address, i.e. demo data by construction.
    const RENAME: Array<[string, { full_name: string; email?: string }]> = [
        ['lars@aurora.example', { full_name: 'Lars Bergström', email: 'lars.bergstrom@aurorafoods.example' }],
        ['smith@aurofoods.example', { full_name: 'Oliver Smith', email: 'oliver.smith@aurorafoods.example' }],
        ['lars@nordmark.example', { full_name: 'Lars Vestby' }],
        ['marit@nordmark.example', { full_name: 'Marit Haugen' }],
        ['ingrid@nordmark.example', { full_name: 'Ingrid Solberg' }],
    ];
    for (const [email, patch] of RENAME) {
        const u = await db.collection('users').findOne({ email });
        if (!u) continue;
        if (u.full_name === patch.full_name && (!patch.email || u.email === patch.email)) continue;
        note(`C. ${email} → "${patch.full_name}"${patch.email ? ` <${patch.email}>` : ''}`);
        if (COMMIT)
            await db.collection('users').updateOne({ _id: u._id }, { $set: { ...patch, updated_at: new Date() } });
    }

    // Roster every surviving Nordmark contact onto NFD — a contact attached to
    // a company but no project shows up nowhere and looks like an orphan.
    // Excluded by subtraction rather than re-query: under a dry run the nine
    // placeholders above are still present, and the report would claim 13.
    const dropped = new Set(dropNord.map((u) => String(u._id)));
    const nordIds = (await db.collection('users').find({ 'client_profile.company_id': nord._id }).toArray())
        .map((u) => u._id as Id)
        .filter((id) => !dropped.has(String(id)));
    note(`C. roster all ${nordIds.length} Nordmark contacts onto NFD`);
    if (COMMIT) await db.collection('projects').updateOne({ _id: nfd._id }, { $set: { representative_ids: nordIds } });

    // ================= D. move the timeline forward =======================
    // Weekday-preserving, so Monday entries stay on Mondays.
    //
    // GUARDED, because this is the one step in the file that is not
    // idempotent: running it twice pushes every date another fortnight, and the
    // second run leaves the demo sitting two weeks in the FUTURE — sprints that
    // have not started, timesheets dated next month. The guard asks the only
    // question that matters: is the data already current? If the newest
    // timesheet is within the last week, there is nothing to catch up.
    const newest = (await db.collection('timesheet_entries').distinct('local_date')).sort().pop() as string | undefined;
    const staleCutoff = shiftIso(new Date().toISOString().slice(0, 10), -7);
    const needsShift = !newest || newest < staleCutoff;

    const tsRows = needsShift ? await db.collection('timesheet_entries').find({}).toArray() : [];
    if (!needsShift)
        note(
            `D. SKIPPED — newest timesheet is ${newest}, already within a week of today. Shifting again would move the demo into the future.`
        );
    else note(`D. shift ${tsRows.length} timesheet entries by +${SHIFT_DAYS}d`);
    if (COMMIT)
        for (const r of tsRows)
            await db
                .collection('timesheet_entries')
                .updateOne({ _id: r._id }, { $set: { local_date: shiftIso(r.local_date as string, SHIFT_DAYS) } });

    for (const s of needsShift ? await db.collection('sprints').find({}).toArray() : []) {
        const from = shiftIso(s.start_date as string, SHIFT_DAYS);
        const to = shiftIso(s.end_date as string, SHIFT_DAYS);
        note(`D. sprint "${s.name}" [${s.status}] ${s.start_date}→${s.end_date}  becomes  ${from}→${to}`);
        if (COMMIT)
            await db.collection('sprints').updateOne({ _id: s._id }, { $set: { start_date: from, end_date: to } });
    }

    // Task due dates shift too, EXCEPT on done tasks — a completed task with a
    // due date next week reads as broken, and the app's own rule (BUG-041)
    // refuses that combination on write.
    const today = new Date().toISOString().slice(0, 10);
    let shifted = 0;
    let capped = 0;
    for (const t of needsShift
        ? await db
              .collection('tasks')
              .find({ due_date: { $ne: null } })
              .toArray()
        : []) {
        const next = shiftIso(t.due_date as string, SHIFT_DAYS);
        const final = t.status === 'done' && next > today ? t.due_date : next;
        if (final === next) shifted++;
        else capped++;
        if (COMMIT) await db.collection('tasks').updateOne({ _id: t._id }, { $set: { due_date: final } });
    }
    note(`D. task due dates: ${shifted} shifted, ${capped} left in place (done tasks that would land in the future)`);

    // ================= E. staff with no work ==============================
    const NEW_TASKS: Array<{
        project: Document;
        title: string;
        desc: string;
        status: string;
        priority: string;
        who: string;
        est: number;
        due: string;
    }> = [
        {
            project: afs,
            title: 'Supplier contract expiry reminders',
            desc: 'Notify category managers 30/14/7 days before a supplier contract lapses.',
            status: 'in_progress',
            priority: 'medium',
            who: 'ishita@viljetech.com',
            est: 8,
            due: '2026-08-14',
        },
        {
            project: afs,
            title: 'Bulk price-list import validation',
            desc: 'Reject malformed CSV price lists with a per-row error report instead of failing the whole upload.',
            status: 'to_do',
            priority: 'high',
            who: 'ishita@viljetech.com',
            est: 12,
            due: '2026-08-19',
        },
        {
            project: afs,
            title: 'Purchase-order approval thresholds',
            desc: 'Route POs above the category limit to a second approver.',
            status: 'review',
            priority: 'medium',
            who: 'ganesh@viljetech.com',
            est: 6,
            due: '2026-08-12',
        },
        {
            project: afs,
            title: 'Archive fulfilled orders after 90 days',
            desc: 'Nightly job moving fulfilled orders out of the hot collection to keep search fast.',
            status: 'done',
            priority: 'low',
            who: 'ganesh@viljetech.com',
            est: 5,
            due: '2026-08-05',
        },
        {
            project: nfd,
            title: 'Fuel consumption trend chart',
            desc: 'Per-vehicle litres/100km over the selected window, with a fleet median baseline.',
            status: 'in_progress',
            priority: 'medium',
            who: 'rahul@viljetech.com',
            est: 10,
            due: '2026-08-17',
        },
        {
            project: nfd,
            title: 'Driver shift handover notes',
            desc: 'Free-text handover attached to a trip, visible to the next driver on the same vehicle.',
            status: 'to_do',
            priority: 'low',
            who: 'rahul@viljetech.com',
            est: 6,
            due: '2026-08-21',
        },
        {
            project: nfd,
            title: 'Geofence breach notification rules',
            desc: 'Configurable per-depot geofences with enter/exit alerts to the duty manager.',
            status: 'to_do',
            priority: 'high',
            who: 'vivek@viljetech.com',
            est: 14,
            due: '2026-08-20',
        },
        {
            project: nfd,
            title: 'Vehicle service-due reminder job',
            desc: 'Flag vehicles crossing the service-interval odometer reading.',
            status: 'done',
            priority: 'medium',
            who: 'vivek@viljetech.com',
            est: 7,
            due: '2026-08-04',
        },
        {
            project: nfd,
            title: 'Idle-time report export',
            desc: 'CSV export of engine-on/stationary time per driver per week.',
            status: 'to_do',
            priority: 'medium',
            who: 'ishita@viljetech.com',
            est: 5,
            due: '2026-08-24',
        },
    ];

    const AUTHORS = ['kavya@viljetech.com', 'rohan@viljetech.com', 'priya@viljetech.com', 'arjun@viljetech.com'];
    const createdTaskIds: Array<{ id: Id; project: Document; who: string; title: string }> = [];
    let seqAfs = (afs.task_seq as number) ?? 0;
    let seqNfd = (nfd.task_seq as number) ?? 0;

    for (const [i, t] of NEW_TASKS.entries()) {
        const exists = await db.collection('tasks').findOne({ project_id: t.project._id, title: t.title });
        if (exists) {
            createdTaskIds.push({ id: exists._id as Id, project: t.project, who: t.who, title: t.title });
            continue;
        }
        const isAfs = String(t.project._id) === String(afs._id);
        const num = isAfs ? ++seqAfs : ++seqNfd;
        const assignee = staff[t.who];
        const author = staff[AUTHORS[i % AUTHORS.length]];
        const _id = new mongoose.Types.ObjectId();
        note(`E. + task ${t.project.code}-${num} "${t.title}" → ${t.who} [${t.status}]`);
        createdTaskIds.push({ id: _id, project: t.project, who: t.who, title: t.title });
        if (COMMIT)
            await db.collection('tasks').insertOne({
                _id,
                project_id: t.project._id,
                sprint_id: null,
                story_id: null,
                parent_task_id: null,
                title: t.title,
                description: t.desc,
                status: t.status,
                priority: t.priority,
                due_date: t.due,
                estimated_hours: t.est,
                primary_assignee_id: assignee,
                assignee_ids: [assignee],
                collaborator_ids: [],
                depends_on_task_ids: [],
                position: 100 + i,
                backlog_rank: 100 + i,
                task_number: num,
                issue_type: 'task',
                labels: [],
                source: null,
                completed_at: t.status === 'done' ? new Date(`${t.due}T11:00:00Z`) : null,
                created_by: author,
                updated_by: author,
                created_at: new Date('2026-07-28T09:15:00Z'),
                updated_at: new Date('2026-08-07T14:20:00Z'),
            });
    }
    if (COMMIT) {
        await db.collection('projects').updateOne({ _id: afs._id }, { $set: { task_seq: seqAfs } });
        await db.collection('projects').updateOne({ _id: nfd._id }, { $set: { task_seq: seqNfd } });
    }

    // Put the new assignees on the project rosters, or their tasks sit in a
    // project they are not a member of.
    for (const [proj, emails] of [
        [afs, ['ishita@viljetech.com', 'ganesh@viljetech.com']],
        [nfd, ['rahul@viljetech.com', 'vivek@viljetech.com', 'ishita@viljetech.com']],
    ] as Array<[Document, string[]]>) {
        const ids = emails.map((e) => staff[e]).filter(Boolean);
        note(`E. add ${emails.join(', ')} to ${proj.code} members`);
        if (COMMIT)
            await db
                .collection('projects')
                .updateOne({ _id: proj._id }, { $addToSet: { member_ids: { $each: ids } } } as Document);
    }

    // Timesheets: Mon-Fri across the two weeks ending today.
    const WORKDAYS = [
        '2026-07-27',
        '2026-07-28',
        '2026-07-29',
        '2026-07-30',
        '2026-07-31',
        '2026-08-03',
        '2026-08-04',
        '2026-08-05',
        '2026-08-06',
        '2026-08-07',
        '2026-08-10',
    ];
    const holidays = new Set(await db.collection('holidays').distinct('date'));

    const TS_PLAN: Array<{
        who: string;
        days: number[];
        task?: string;
        general?: string;
        billable: number;
        nonBillable: number;
        desc: string;
    }> = [
        {
            who: 'ishita@viljetech.com',
            days: [0, 1, 2, 5, 6, 7, 9, 10],
            task: 'Supplier contract expiry reminders',
            billable: 6,
            nonBillable: 1,
            desc: 'Reminder scheduling + notification templates',
        },
        {
            who: 'rahul@viljetech.com',
            days: [1, 2, 3, 5, 6, 8, 9],
            task: 'Fuel consumption trend chart',
            billable: 6,
            nonBillable: 1,
            desc: 'Consumption aggregation query and chart wiring',
        },
        {
            who: 'ganesh@viljetech.com',
            days: [0, 2, 4, 5, 7, 9, 10],
            task: 'Purchase-order approval thresholds',
            billable: 5,
            nonBillable: 2,
            desc: 'Approval routing rules and reviewer assignment',
        },
        {
            who: 'vivek@viljetech.com',
            days: [1, 3, 4, 6, 8, 10],
            task: 'Geofence breach notification rules',
            billable: 6,
            nonBillable: 1,
            desc: 'Geofence model, breach detection and alert fan-out',
        },
        {
            who: 'chary@viljetech.com',
            days: [0, 2, 4, 6, 8, 10],
            general: 'Project management',
            billable: 4,
            nonBillable: 3,
            desc: 'Delivery reviews, client check-ins and resourcing',
        },
    ];

    let tsAdded = 0;
    for (const p of TS_PLAN) {
        const uid = staff[p.who];
        if (!uid) continue;
        const linked = p.task ? createdTaskIds.find((c) => c.title === p.task) : undefined;
        for (const dIdx of p.days) {
            const date = WORKDAYS[dIdx];
            if (holidays.has(date)) continue;
            const dupe = await db.collection('timesheet_entries').findOne({ user_id: uid, local_date: date });
            if (dupe) continue;
            tsAdded++;
            if (COMMIT)
                await db.collection('timesheet_entries').insertOne({
                    user_id: uid,
                    local_date: date,
                    entry_type: linked ? 'task_linked' : 'general',
                    project_id: linked ? linked.project._id : null,
                    sprint_id: null,
                    task_id: linked ? linked.id : null,
                    general_category: linked ? null : p.general,
                    billable_hours: p.billable,
                    billable_minutes: 0,
                    billable_total_minutes: p.billable * 60,
                    non_billable_hours: p.nonBillable,
                    non_billable_minutes: 0,
                    non_billable_total_minutes: p.nonBillable * 60,
                    total_minutes: (p.billable + p.nonBillable) * 60,
                    description: p.desc,
                    last_edited_by: uid,
                    last_edited_at: new Date(`${date}T12:00:00Z`),
                    created_at: new Date(`${date}T12:00:00Z`),
                    updated_at: new Date(`${date}T12:00:00Z`),
                });
        }
    }
    note(`E. + ${tsAdded} timesheet entries across 5 staff`);

    // ================= F. spread authorship off admin =====================
    const adminId = staff['admin@viljetech.com'];
    const authored = await db.collection('tasks').find({ created_by: adminId }).toArray();
    if (authored.length) {
        note(`F. reassign created_by on ${authored.length} task(s) from admin → ${AUTHORS.join(', ')}`);
        if (COMMIT)
            for (const [i, t] of authored.entries()) {
                const a = staff[AUTHORS[i % AUTHORS.length]];
                await db.collection('tasks').updateOne({ _id: t._id }, { $set: { created_by: a, updated_by: a } });
            }
    }

    console.log(log.join('\n'));
    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing written. Re-run with --commit.');
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
