/**
 * Replace generated task descriptions and realign the activity feed.
 *
 *   npx tsx scripts/demo-descriptions.ts             # dry run
 *   npx tsx scripts/demo-descriptions.ts --commit
 *
 * Two tells this fixes:
 *
 *  1. Every seeded task's description was literally "<title> (<project name>)".
 *     Reading two of those in a row tells an audience the data is generated.
 *  2. `demo-humanize` moved `created_by` off the admin account, but the
 *     `task_activities` rows still said "Vilje Admin created the task" — so the
 *     detail page contradicted its own header. The actor is realigned to the
 *     task's real author.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');

const DESCRIPTIONS: Record<string, string> = {
    // --- Nordmark Fleet Dashboard ---
    'Implement GPS polling fallback':
        'When a unit stops reporting over the websocket, fall back to polling its last known position every 60s so the vehicle does not vanish from the map. Restore the stream automatically once it recovers.',
    'Driver marker clustering at low zoom':
        'Above ~200 vehicles the map becomes unreadable at country zoom. Cluster markers by proximity and expand on zoom-in, keeping the alert state visible on the cluster badge.',
    'Live-location websocket reconnect logic':
        'Reconnect with exponential backoff capped at 30s instead of retrying every second, and surface a reconnecting indicator once the socket has been down for more than 5s.',
    'Route playback scrubber UI':
        'Let a dispatcher scrub through a completed trip and see the vehicle position, speed and stop events at each point. Playback speeds 1x/4x/16x.',
    'Trip history list with date filter':
        'Paginated trip list per vehicle with a date-range filter and a CSV export. Defaults to the last 7 days.',
    'Engine-fault alert webhook ingestion':
        'Accept fault codes pushed by the telematics provider, normalise them against our severity table and raise an alert. Older units omit severity entirely — default those to warning and log the unit id.',
    'Alert severity triage rules':
        'Configurable rules mapping a fault code plus vehicle class to a severity, so a coolant warning on a refrigerated truck escalates faster than on a van.',
    'Depot kiosk QR check-in screen':
        'Full-screen kiosk view at each depot: driver scans their badge QR, confirms vehicle and odometer, and the trip opens against them.',
    'Provision staging fleet simulator':
        'Stand up a simulator that replays recorded telemetry for 50 vehicles so staging has realistic movement without touching customer units.',
    'CI pipeline for map tile cache':
        'Build and publish the offline tile cache as part of CI rather than by hand, so a stale cache can never reach production unnoticed.',

    // --- Aurora Foods Supply Portal ---
    'Add supplier KYC document upload':
        'Suppliers upload registration and tax documents during onboarding. Validate file type and size on the client, virus-scan on receipt, and put the submission into the compliance review queue.',
    'Supplier onboarding step validation':
        'Each wizard step must validate before the supplier can advance, and a half-finished application should be resumable from the emailed link for 30 days.',
    'Fix invoice rounding for SEK':
        'Totals were rounded per line and then summed, which drifted by up to 0.05 SEK on large invoices. Round once at the total, and add a regression test with the invoice that surfaced it.',
    'Invoice line-item matching engine':
        'Match supplier invoice lines to purchase-order lines using PO number plus line quantity. Anything with more than two candidate matches goes to manual review rather than auto-matching.',
    'Credit-note handling for partial returns':
        'Support a credit note covering part of a delivery, linked to the original invoice, with the remaining balance still payable.',
    'Order status timeline component':
        'Chronological timeline of an order from placement to delivery. Collapsed to the last three events by default, timestamps rendered in the supplier’s own timezone.',
    'E2E tests for onboarding wizard':
        'Playwright coverage for the full supplier onboarding path including document upload, resume-from-link and the rejection route.',
    'Load test order search endpoint':
        'Order search slows badly past ~50k orders. Establish a baseline under realistic load, then decide between an index change and a search service.',
    'Dockerize supplier-portal service':
        'Container image plus compose setup so the service runs identically locally and in staging, replacing the current manual node setup.',
    'Set up SFTP intake for legacy EDI orders':
        'Two of the largest suppliers still send EDI files over SFTP. Poll the drop folder, parse into orders, and quarantine anything malformed with a readable error report.',
};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-descriptions.ts');
    const db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

    let d = 0;
    for (const [title, description] of Object.entries(DESCRIPTIONS)) {
        const t = await db.collection('tasks').findOne({ title });
        if (!t) {
            console.log(`skip "${title}" — not found`);
            continue;
        }
        if (t.description === description) continue;
        d++;
        if (COMMIT)
            await db.collection('tasks').updateOne({ _id: t._id }, { $set: { description, updated_at: new Date() } });
    }
    console.log(`descriptions rewritten: ${d}`);

    // Realign the activity feed with the task's actual author.
    let a = 0;
    for (const t of await db.collection('tasks').find({}).toArray()) {
        const filter = { task_id: t._id, actor_id: { $ne: t.created_by } };
        a += await db.collection('task_activities').countDocuments(filter);
        if (COMMIT) await db.collection('task_activities').updateMany(filter, { $set: { actor_id: t.created_by } });
    }
    console.log(`activity rows realigned to the task author: ${a}`);

    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing written.');
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
