/**
 * Final pre-demo text polish. Run AFTER demo-humanize.ts.
 *
 *   npx tsx scripts/demo-polish.ts             # dry run
 *   npx tsx scripts/demo-polish.ts --commit
 *
 * Replaces free text that a human typed while testing — "te5y6t",
 * "4575674545345", "fwgrfgsr" — with text that fits the row it is attached to.
 * Every replacement is written against the actual task / leave it belongs to,
 * not a generic filler string, because a note that does not match its task is
 * just a different flavour of wrong.
 *
 * Leave reasons of "—" are left alone: that is the app's own "no reason given"
 * placeholder and reads correctly.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const O = (s: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(s);

/** id → replacement, chosen to match the linked task. */
const TIMESHEET_NOTES: Array<[string, string]> = [
    ['6a5f5272fabe3e711b0222b4', 'KYC upload form, file-type validation and the reviewer queue'],
    ['6a5f5d4efabe3e711b0222cb', 'Sprint planning and backlog grooming with the supplier-portal team'],
    ['6a61c2efbe011cdf3f121f72', 'Reconnect backoff logic and the reconnecting state in the map UI'],
    ['6a66f9fd431d108e4e94a963', 'Trip history pagination and the date-range filter'],
    ['6a66fde4ed18bfbc9416b408', 'Webhook ingestion endpoint plus payload validation for engine faults'],
];

const LEAVE_REASONS: Array<[string, string]> = [
    ['6a6244e4c204d7053dc480de', 'Plans changed — withdrew the request'],
    ['6a67518358f9ddafabcf2331', 'Family holiday, back the following Monday'],
    ['6a6757b458f9ddafabcf234f', 'Personal errand, half a day at most'],
    ['6a69ce468cb0f7a4ea679918', 'Medical appointment'],
    ['6a6c513ea4b9054a137fde0d', 'Rescheduled to a later date'],
];

/** Junk categories → the two real ones already in use. */
// Targets must be TIMESHEET_GENERAL_CATEGORIES values: this rewrites rows in
// place, and most of what it cleans up is project-less general time, where a
// free-text category is no longer valid and blocks any later edit of the row.
const CATEGORY_MAP: Record<string, string> = {
    'Test one': 'Meeting',
    'Test one edit': 'Meeting',
    'working of certificates': 'Documentation',
};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-polish.ts');
    const db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

    for (const [id, text] of TIMESHEET_NOTES) {
        const row = await db.collection('timesheet_entries').findOne({ _id: O(id) });
        if (!row) {
            console.log(`skip timesheet ${id} — not found`);
            continue;
        }
        console.log(`timesheet ${JSON.stringify(row.description)} → ${JSON.stringify(text)}`);
        if (COMMIT)
            await db
                .collection('timesheet_entries')
                .updateOne({ _id: O(id) }, { $set: { description: text, updated_at: new Date() } });
    }

    for (const [id, text] of LEAVE_REASONS) {
        const row = await db.collection('leave_requests').findOne({ _id: O(id) });
        if (!row) {
            console.log(`skip leave ${id} — not found`);
            continue;
        }
        console.log(`leave     ${JSON.stringify(row.reason)} → ${JSON.stringify(text)}`);
        if (COMMIT)
            await db
                .collection('leave_requests')
                .updateOne({ _id: O(id) }, { $set: { reason: text, updated_at: new Date() } });
    }

    for (const [from, to] of Object.entries(CATEGORY_MAP)) {
        const n = await db.collection('timesheet_entries').countDocuments({ general_category: from });
        if (!n) continue;
        console.log(`category  ${JSON.stringify(from)} → ${JSON.stringify(to)}  (${n} row(s))`);
        if (COMMIT)
            await db
                .collection('timesheet_entries')
                .updateMany({ general_category: from }, { $set: { general_category: to } });
    }

    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing written.');
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
