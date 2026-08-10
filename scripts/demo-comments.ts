/**
 * Seed realistic discussion on the demo tasks.
 *
 *   npx tsx scripts/demo-comments.ts             # dry run
 *   npx tsx scripts/demo-comments.ts --commit
 *
 * The prune left `task_comments` empty — every comment lived on a task that
 * belonged to a deleted project — so every task detail page opens with a blank
 * discussion panel. Threads are attached to tasks that are actually in flight
 * (in_progress / review), because commentary on a to_do nobody has started is
 * where seeded data gives itself away.
 *
 * Attachments are deliberately NOT seeded: the row is only a pointer to an
 * Azure blob, and a fabricated row means a download button that 404s in front
 * of an audience. Upload one by hand during the demo instead.
 *
 * Authors are drawn from each task's own project roster, so nobody comments on
 * a project they are not a member of.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');

/** title → the thread, in order. Author is an index into the project roster. */
const THREADS: Record<string, Array<[number, string]>> = {
    'Invoice line-item matching engine': [
        [
            0,
            'Matching on PO number alone breaks when the supplier splits a delivery across two invoices. Adding line-level quantity as a secondary key.',
        ],
        [
            1,
            'Agreed. Worth capping the fuzzy match at 2 candidates so we never auto-match ambiguously — a wrong auto-match is much more expensive than a manual review.',
        ],
        [0, 'Done. Anything above 2 candidates now lands in the review queue with both options shown side by side.'],
    ],
    'Order status timeline component': [
        [
            1,
            'Design want the timeline collapsed to the last 3 events by default, with "show full history" underneath. Sending the updated frames over.',
        ],
        [
            2,
            'That works. One thing — timestamps need the supplier’s timezone, not ours. Aurora’s Malmö team was reading UTC as local last week.',
        ],
    ],
    'Supplier contract expiry reminders': [
        [
            0,
            'First pass sends at 30/14/7 days. Should the 7-day one also go to the category manager’s manager, or is that too noisy?',
        ],
        [1, 'Keep it to the owner for now. We can escalate later if we see contracts actually lapsing.'],
    ],
    'Purchase-order approval thresholds': [
        [
            2,
            'Threshold is per category rather than a single global number — Packaging and Logistics have very different typical order sizes.',
        ],
        [
            0,
            'Ready for review. Second approver is picked from the category owner list, falling back to the finance group if the category has no owner set.',
        ],
    ],
    'Live-location websocket reconnect logic': [
        [
            0,
            'Reconnect now uses exponential backoff capped at 30s. The old version hammered the gateway every second on a flaky mobile connection.',
        ],
        [1, 'Can we surface the reconnecting state in the UI? Drivers thought the map had frozen.'],
        [0, 'Added a subtle banner after 5s of disconnection. Not a modal — they are driving.'],
    ],
    'Engine-fault alert webhook ingestion': [
        [
            1,
            'Payloads from the older telematics units are missing the severity field entirely. Defaulting those to "warning" rather than dropping them.',
        ],
        [2, 'Good call. Please log the unit id when that happens so we can chase the firmware upgrade separately.'],
    ],
    'Fuel consumption trend chart': [
        [
            0,
            'Using a 7-day rolling median rather than a mean — one refuelling error was skewing a whole vehicle’s line.',
        ],
    ],
    'Geofence breach notification rules': [
        [
            1,
            'Depots need per-site radii; the yard in Bergen is much larger than the city depots. Making it a per-geofence field rather than one constant.',
        ],
    ],
};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-comments.ts');
    const db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

    let n = 0;
    for (const [title, thread] of Object.entries(THREADS)) {
        const task = await db.collection('tasks').findOne({ title });
        if (!task) {
            console.log(`skip "${title}" — task not found`);
            continue;
        }
        const existing = await db.collection('task_comments').countDocuments({ task_id: task._id });
        if (existing > 0) {
            console.log(`skip "${title}" — already has ${existing} comment(s)`);
            continue;
        }
        const project = (await db.collection('projects').findOne({ _id: task.project_id }))!;
        const roster = (project.member_ids ?? []) as mongoose.Types.ObjectId[];
        if (roster.length === 0) {
            console.log(`skip "${title}" — project has no members to attribute comments to`);
            continue;
        }

        // Spread across the two working days before the task was last touched.
        const base = new Date(task.updated_at as Date).getTime();
        for (const [i, [who, body]] of thread.entries()) {
            const author = roster[who % roster.length];
            const when = new Date(base - (thread.length - i) * 26 * 3_600_000);
            n++;
            if (COMMIT)
                await db.collection('task_comments').insertOne({
                    task_id: task._id,
                    author_id: author,
                    body,
                    mentioned_user_ids: [],
                    is_edited: false,
                    deleted_at: null,
                    created_at: when,
                    updated_at: when,
                });
        }
        console.log(`"${title}" ← ${thread.length} comment(s)`);
    }

    console.log(`\n${n} comment(s) ${COMMIT ? 'inserted' : 'would be inserted'}.`);
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
