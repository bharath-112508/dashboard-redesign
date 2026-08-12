/**
 * Backfill `internal_profile.reporting_manager_id` from the PROJECT ROSTERS.
 *
 *   npx tsx scripts/backfill-reporting-chain.ts                      # dry run
 *   npx tsx scripts/backfill-reporting-chain.ts --commit             # safelisted DBs
 *   npx tsx scripts/backfill-reporting-chain.ts --commit --allow-prod
 *
 * WHY THIS EXISTS
 * ---------------
 * Every team-facing read scopes by DIRECT reports — team timesheets, team
 * attendance, leave approvals, comp-off (`reporting-scope.service.ts`). Where
 * the field is unset, `directReportIdsOf` returns `[]` and the Manager or Team
 * Lead opens those pages to nothing.
 *
 * That was invisible until `/timesheets/summary` was scoped to match the rest.
 * Before, summary ignored the chain and showed everyone — so a manager saw
 * *something* and the gap looked like a quirk rather than missing data. Closing
 * that hole makes the missing chart visible, which is why this backfill has to
 * land BEFORE (or with) that change on any environment that has real users.
 *
 * HOW THE CHART IS DERIVED
 * ------------------------
 * Nothing is invented and no structure is hardcoded — it is read from who
 * works with whom:
 *
 *   employee   → a team lead on a project they share (most-recent project wins)
 *   team lead  → a manager, spread evenly so no manager ends up with an empty
 *                team view; a manager sharing their project is preferred
 *   manager    → the single active admin
 *   admin, client, representative → untouched (externals have no chain)
 *
 * ANYONE WHO ALREADY HAS A MANAGER IS LEFT ALONE. This is a backfill, not a
 * reorganisation: it only fills holes, so a chart someone set by hand always
 * wins. Re-running it is therefore a no-op once the holes are closed.
 *
 * SAFETY
 * ------
 * Unlike the `demo-*` scripts this one is NOT destructive — it sets one field
 * and never deletes — so it is allowed to run outside `SAFE_DB_NAMES`, but only
 * when you say `--allow-prod` as well as `--commit`. Two flags, because the
 * cost of running it on the wrong database is a wrong org chart, and a wrong
 * org chart silently changes who can see whose hours.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { SAFE_DB_NAMES } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');
const ALLOW_PROD = process.argv.includes('--allow-prod');

type Id = mongoose.Types.ObjectId;
interface UserRow {
    _id: Id;
    email: string;
    full_name: string;
    role: string;
    internal_profile?: { reporting_manager_id?: Id | null };
}

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const db = mongoose.connection.db!;
    const dbName = db.databaseName;
    const safelisted = SAFE_DB_NAMES.has(dbName);

    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}   safelisted: ${safelisted}\n`);
    if (COMMIT && !safelisted && !ALLOW_PROD) {
        console.error(
            `Refusing to write to '${dbName}' — it is not in SAFE_DB_NAMES.\n` +
                'This looks like a real environment. Re-run with --allow-prod if you mean it.'
        );
        process.exitCode = 1;
        await mongoose.disconnect();
        return;
    }

    const users = (await db
        .collection('users')
        .find({ status: 'active' })
        .project({ _id: 1, email: 1, full_name: 1, role: 1, 'internal_profile.reporting_manager_id': 1 })
        .toArray()) as unknown as UserRow[];

    const byId = new Map(users.map((u) => [String(u._id), u]));
    const of = (role: string): UserRow[] => users.filter((u) => u.role === role);
    const hasManager = (u: UserRow): boolean => Boolean(u.internal_profile?.reporting_manager_id);

    const admin = of('admin')[0];
    const managers = of('manager');
    const leads = of('team_lead');

    // Projects, newest first — "most-recent project wins" for anyone on several.
    const projects = (await db
        .collection('projects')
        .find({}, { projection: { _id: 1, name: 1, member_ids: 1, created_at: 1 } })
        .sort({ created_at: -1 })
        .toArray()) as unknown as { _id: Id; name: string; member_ids?: Id[] }[];

    /** First colleague on a shared project holding `role`. */
    const sharedColleague = (person: UserRow, role: string): UserRow | undefined => {
        for (const p of projects) {
            const ids = (p.member_ids ?? []).map(String);
            if (!ids.includes(String(person._id))) continue;
            const found = ids
                .map((id) => byId.get(id))
                .find((c): c is UserRow => Boolean(c) && c!.role === role && String(c!._id) !== String(person._id));
            if (found) return found;
        }
        return undefined;
    };

    const plan: { report: UserRow; manager: UserRow; why: string }[] = [];
    const skipped: { user: UserRow; why: string }[] = [];

    // Employees → a team lead they actually work with; fall back to a manager.
    for (const e of of('employee')) {
        if (hasManager(e)) continue;
        const lead = sharedColleague(e, 'team_lead');
        const mgr = lead ?? sharedColleague(e, 'manager');
        if (mgr) plan.push({ report: e, manager: mgr, why: lead ? 'shared project (lead)' : 'shared project (mgr)' });
        else skipped.push({ user: e, why: 'no project with a lead or manager' });
    }

    // Team leads → a manager. Prefer one on a shared project; otherwise spread
    // round-robin so every manager has someone and none opens to an empty page.
    let rr = 0;
    for (const l of leads) {
        if (hasManager(l)) continue;
        const shared = sharedColleague(l, 'manager');
        const mgr = shared ?? managers[rr++ % Math.max(managers.length, 1)] ?? admin;
        if (mgr) plan.push({ report: l, manager: mgr, why: shared ? 'shared project' : 'spread evenly' });
        else skipped.push({ user: l, why: 'no manager or admin exists' });
    }

    // Managers → the admin.
    for (const m of managers) {
        if (hasManager(m)) continue;
        if (admin) plan.push({ report: m, manager: admin, why: 'top of chain' });
        else skipped.push({ user: m, why: 'no active admin' });
    }

    for (const { report, manager, why } of plan) {
        console.log(`  ${report.full_name.padEnd(22)} → ${manager.full_name.padEnd(22)} (${why})`);
    }
    for (const { user, why } of skipped) {
        console.log(`  SKIP ${user.full_name.padEnd(19)} — ${why}`);
    }

    if (COMMIT) {
        for (const { report, manager } of plan) {
            await db
                .collection('users')
                .updateOne(
                    { _id: report._id },
                    { $set: { 'internal_profile.reporting_manager_id': manager._id } }
                );
        }
    }

    const untouched = users.filter(hasManager).length;
    console.log(
        `\n${COMMIT ? 'Set' : 'Would set'}: ${plan.length}   left alone (already had one): ${untouched}   ` +
            `could not place: ${skipped.length}`
    );

    // The point of the exercise: nobody who manages people opens an empty page.
    console.log('\nResulting direct reports:');
    const counts = new Map<string, number>();
    for (const { manager } of plan) counts.set(manager.full_name, (counts.get(manager.full_name) ?? 0) + 1);
    for (const u of users) {
        const existing = u.internal_profile?.reporting_manager_id;
        if (!existing) continue;
        const m = byId.get(String(existing));
        if (m) counts.set(m.full_name, (counts.get(m.full_name) ?? 0) + 1);
    }
    for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(22)} ${n}`);
    for (const m of [...managers, ...leads]) {
        if (!counts.has(m.full_name)) console.log(`  ${m.full_name.padEnd(22)} 0   ← will see an empty team view`);
    }

    await mongoose.disconnect();
};

void main();
