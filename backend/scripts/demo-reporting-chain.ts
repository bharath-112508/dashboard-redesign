/**
 * Set `internal_profile.reporting_manager_id` on the internal staff.
 *
 *   npx tsx scripts/demo-reporting-chain.ts             # dry run
 *   npx tsx scripts/demo-reporting-chain.ts --commit
 *
 * Every team-facing read scopes by DIRECT reports — team timesheets, team
 * attendance, leave approvals, comp-off (`reporting-scope.service.ts`). The
 * demo dataset had this field unset on all 25 users, so `directReportIdsOf`
 * returned `[]` and every Manager and Team Lead saw a blank screen on each of
 * those pages. Nothing was broken in the code; there was simply no org chart.
 *
 * The chain is derived from the PROJECT ROSTERS rather than invented, so it
 * matches the work people are actually logging:
 *
 *   employee   → the team lead on their project
 *   team lead  → a manager
 *   manager    → the admin
 *   admin      → nobody
 *   client / representative → nobody (external; they have no internal_profile)
 *
 * Two people (Aditya, Ishita) sit on both delivery projects. A person has one
 * reporting manager, so they follow their FIRST-listed project — the roster
 * order is the seed's own notion of primary assignment.
 *
 * Managers are spread across the four team leads rather than piled onto one,
 * so no manager account opens to an empty team view either.
 *
 * Re-runnable: it writes by email, and skips anyone already pointing at the
 * intended manager.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');

/** report email → manager email. */
const CHAIN: Record<string, string> = {
    // Aurora Foods delivery team → its team lead
    'sneha@viljetech.com': 'rohan@viljetech.com',
    'karthik@viljetech.com': 'rohan@viljetech.com',
    'aditya@viljetech.com': 'rohan@viljetech.com',
    'ishita@viljetech.com': 'rohan@viljetech.com',

    // Nordmark Fleet delivery team → its team lead
    'ananya@viljetech.com': 'kavya@viljetech.com',
    'vikram@viljetech.com': 'kavya@viljetech.com',
    'rahul@viljetech.com': 'kavya@viljetech.com',

    // Team leads → managers, one manager per lead so all three have a team
    'rohan@viljetech.com': 'priya@viljetech.com',
    'kavya@viljetech.com': 'arjun@viljetech.com',
    'ganesh@viljetech.com': 'chary@viljetech.com',
    'vivek@viljetech.com': 'chary@viljetech.com',

    // Managers → admin
    'arjun@viljetech.com': 'admin@viljetech.com',
    'chary@viljetech.com': 'admin@viljetech.com',
    'priya@viljetech.com': 'admin@viljetech.com',
};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-reporting-chain.ts');
    const db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

    const emails = [...new Set([...Object.keys(CHAIN), ...Object.values(CHAIN)])];
    const users = await db
        .collection('users')
        .find({ email: { $in: emails } })
        .project({ _id: 1, email: 1, full_name: 1, 'internal_profile.reporting_manager_id': 1 })
        .toArray();
    const byEmail = new Map(users.map((u) => [u.email as string, u]));

    const missing = emails.filter((e) => !byEmail.has(e));
    if (missing.length > 0) {
        // Refuse rather than write a partial chart — a half-set chain looks
        // exactly like the bug this script exists to fix.
        console.error(`ABORT — these accounts do not exist:\n  ${missing.join('\n  ')}`);
        process.exitCode = 1;
        return;
    }

    let set = 0;
    let already = 0;
    for (const [reportEmail, managerEmail] of Object.entries(CHAIN)) {
        const report = byEmail.get(reportEmail)!;
        const manager = byEmail.get(managerEmail)!;
        const current = report.internal_profile?.reporting_manager_id;

        if (current && String(current) === String(manager._id)) {
            already += 1;
            continue;
        }
        console.log(`  ${String(report.full_name).padEnd(18)} → ${manager.full_name}`);
        if (COMMIT) {
            await db
                .collection('users')
                .updateOne(
                    { _id: report._id },
                    { $set: { 'internal_profile.reporting_manager_id': manager._id } }
                );
        }
        set += 1;
    }

    console.log(`\n${COMMIT ? 'Set' : 'Would set'}: ${set}   already correct: ${already}`);

    // Report the resulting team sizes — the whole point is that no internal
    // manager or team lead opens a team page to nothing.
    if (COMMIT) {
        console.log('\nResulting direct reports:');
        for (const email of new Set(Object.values(CHAIN))) {
            const m = byEmail.get(email)!;
            const n = await db
                .collection('users')
                .countDocuments({ 'internal_profile.reporting_manager_id': m._id, status: 'active' });
            console.log(`  ${String(m.full_name).padEnd(18)} ${n}`);
        }
    }

    await mongoose.disconnect();
};

void main();
