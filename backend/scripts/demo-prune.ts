/**
 * Pre-demo prune: reduce the demo dataset to two companies and one populated
 * project each, and remove the test artifacts that make it look unfinished.
 *
 *   npx tsx scripts/demo-prune.ts             # dry run — counts only, writes nothing
 *   npx tsx scripts/demo-prune.ts --commit    # apply
 *
 * Guarded by `assertSafeDb`, so it refuses to run against anything that is not
 * an explicitly safelisted dev/demo database.
 *
 * Order matters: children before parents, and dangling-reference repair LAST,
 * because the repair step needs to know which ids actually survived rather
 * than which ids we intended to keep.
 *
 * Deliberately NOT touched:
 *   - attendance / leaves / comp-off / payroll for surviving staff — none of it
 *     references a project, and it is what makes employees look like real
 *     people during the demo.
 *   - audit_logs — an audit trail with holes is worse than one mentioning
 *     things that no longer exist, and the log view renders text, not links.
 *   - subscription_plans / responsibility_lines / client_counters — global
 *     `is_system` config, not per-company data.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Collection, Document, Filter } from 'mongodb';

import { assertSafeDb } from './_safe-db.js';

const COMMIT = process.argv.includes('--commit');

const KEEP_COMPANY_NAMES = ['Aurora Foods AB', 'Nordmark Logistics AS'];
const KEEP_PROJECT_CODES = ['AFS', 'NFD'];

/** Throwaway accounts: zero tasks, zero timesheets, zero activity. */
const JUNK_STAFF_EMAILS = [
    'incorrect@viljetech.com',
    'rm.probe.0730@viljetech.com',
    'deleted-ad21bcc0@anonymised.invalid',
    'surya@viljetech.com',
];

/** Test rows sitting in a project we keep. */
const JUNK_TASK_TITLES = [/^test bug ?report/i];

type Id = mongoose.Types.ObjectId;

const plan: Array<{ what: string; n: number }> = [];
let db!: mongoose.mongo.Db;

const col = (n: string): Collection<Document> => db.collection(n);

/** Count under dry run, delete under --commit. Records either way. */
const prune = async (name: string, filter: Filter<Document>, label?: string): Promise<number> => {
    const c = col(name);
    const n = await c.countDocuments(filter);
    if (n > 0) {
        plan.push({ what: label ?? `${name}`, n });
        if (COMMIT) await c.deleteMany(filter);
    }
    return n;
};

const repair = async (name: string, filter: Filter<Document>, update: Document, label: string): Promise<void> => {
    const n = await col(name).countDocuments(filter);
    if (n > 0) {
        plan.push({ what: `repair: ${label}`, n });
        if (COMMIT) await col(name).updateMany(filter, update);
    }
};

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const dbName = assertSafeDb('demo-prune.ts');
    db = mongoose.connection.db!;
    console.log(`DB: ${dbName}   mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)'}\n`);

    // ---- resolve what survives -------------------------------------------
    const keepCompanies = await col('companies')
        .find({ name: { $in: KEEP_COMPANY_NAMES } })
        .toArray();
    if (keepCompanies.length !== KEEP_COMPANY_NAMES.length)
        throw new Error(`expected ${KEEP_COMPANY_NAMES.length} keep-companies, found ${keepCompanies.length}`);
    const keepCompanyIds = keepCompanies.map((c) => c._id as Id);

    const keepProjects = await col('projects')
        .find({ code: { $in: KEEP_PROJECT_CODES } })
        .toArray();
    if (keepProjects.length !== KEEP_PROJECT_CODES.length)
        throw new Error(`expected ${KEEP_PROJECT_CODES.length} keep-projects, found ${keepProjects.length}`);
    const keepProjectIds = keepProjects.map((p) => p._id as Id);

    console.log('KEEP companies:', keepCompanies.map((c) => c.name).join(', '));
    console.log('KEEP projects :', keepProjects.map((p) => `${p.code} ${p.name}`).join(' | '), '\n');

    // Everything not kept.
    const doomedProjectIds = (
        await col('projects')
            .find({ _id: { $nin: keepProjectIds } }, { projection: { _id: 1 } })
            .toArray()
    ).map((p) => p._id as Id);
    const doomedCompanyIds = (
        await col('companies')
            .find({ _id: { $nin: keepCompanyIds } }, { projection: { _id: 1 } })
            .toArray()
    ).map((c) => c._id as Id);

    // Tasks die with their project, plus the junk rows inside surviving ones.
    const doomedTaskIds = (
        await col('tasks')
            .find(
                {
                    $or: [{ project_id: { $in: doomedProjectIds } }, { title: { $in: JUNK_TASK_TITLES } }],
                },
                { projection: { _id: 1 } }
            )
            .toArray()
    ).map((t) => t._id as Id);

    // Client-side people of doomed companies + the junk staff accounts.
    const doomedUserIds = (
        await col('users')
            .find(
                {
                    $or: [
                        {
                            role: { $in: ['client', 'representative'] },
                            'client_profile.company_id': { $nin: keepCompanyIds },
                        },
                        { email: { $in: JUNK_STAFF_EMAILS } },
                    ],
                },
                { projection: { _id: 1, email: 1, role: 1 } }
            )
            .toArray()
    ).map((u) => u._id as Id);

    console.log(
        `doomed: ${doomedCompanyIds.length} companies, ${doomedProjectIds.length} projects, ` +
            `${doomedTaskIds.length} tasks, ${doomedUserIds.length} users\n`
    );

    const inProj = { $in: doomedProjectIds };
    const inComp = { $in: doomedCompanyIds };
    const inTask = { $in: doomedTaskIds };
    const inUser = { $in: doomedUserIds };

    // ---- 1. task children -------------------------------------------------
    await prune('task_comments', { task_id: inTask });
    await prune('task_activities', { task_id: inTask });
    await prune('task_attachments', { task_id: inTask });

    // ---- 2. project children ---------------------------------------------
    await prune('tasks', { _id: inTask });
    await prune('sprints', { project_id: inProj });
    await prune('stories', { project_id: inProj });
    await prune('timesheet_entries', { $or: [{ project_id: inProj }, { task_id: inTask }] });
    await prune('billing_rates', { project_id: inProj });
    await prune('project_share_links', { project_id: inProj });
    await prune('task_templates', { project_id: inProj });

    // ---- 3. projects ------------------------------------------------------
    await prune('projects', { _id: inProj });

    // ---- 4. company-scoped rows (incl. the newer client-management module) -
    for (const c of [
        'client_classifications',
        'client_contacts',
        'client_health',
        'client_health_snapshots',
        'client_legal_entities',
        'client_onboarding',
        'client_raci_assignments',
        'contract_amendments',
        'contract_versions',
        'engagements',
        'escalation_paths',
        'governance_meetings',
        'invoices',
        'ownership_delegations',
        'subscriptions',
        'usage_meters',
        'usage_records',
    ])
        await prune(c, { company_id: inComp });

    await prune('client_relationships', {
        $or: [{ source_company_id: inComp }, { target_company_id: inComp }],
    });

    // ---- 5. companies -----------------------------------------------------
    await prune('companies', { _id: inComp });

    // ---- 6. deleted users' own rows ---------------------------------------
    for (const c of [
        'refresh_tokens',
        'push_subscriptions',
        'password_reset_tokens',
        'notifications',
        'leave_requests',
        'leave_balances',
        'attendance_records',
        'attendance_correction_requests',
        'comp_off_ledger',
        'comp_off_accrual_days',
        'payroll_profiles',
        'salary_structures',
        'payslips',
        'letters',
        'report_presets',
        'report_subscriptions',
        'report_exports',
    ])
        await prune(c, { user_id: inUser });
    await prune('timesheet_entries', { user_id: inUser }, 'timesheet_entries (deleted users)');
    await prune('users', { _id: inUser });

    // ---- 7. notifications pointing at things that no longer exist ---------
    // A demo where the bell opens a 404 is worse than an empty bell.
    await prune(
        'notifications',
        { 'related_entity.id': { $in: [...doomedTaskIds, ...doomedProjectIds] } },
        'notifications (dangling target)'
    );

    // ---- 8. repair dangling refs on SURVIVORS ------------------------------
    // Derived by subtraction, NOT by re-querying. Under --commit a re-query
    // would be correct, but under a dry run nothing has been deleted yet, so
    // every doomed id still reads as live and every repair count comes back 0.
    // A dry run that under-reports is worse than no dry run.
    const doomedUserSet = new Set(doomedUserIds.map(String));
    const doomedProjectSet = new Set(doomedProjectIds.map(String));
    const liveUserIds = (
        await col('users')
            .find({}, { projection: { _id: 1 } })
            .toArray()
    )
        .map((u) => u._id as Id)
        .filter((id) => !doomedUserSet.has(String(id)));
    const liveProjectIds = (
        await col('projects')
            .find({}, { projection: { _id: 1 } })
            .toArray()
    )
        .map((p) => p._id as Id)
        .filter((id) => !doomedProjectSet.has(String(id)));

    await repair(
        'projects',
        { member_ids: { $elemMatch: { $nin: liveUserIds } } },
        { $pull: { member_ids: { $nin: liveUserIds } } } as Document,
        'projects.member_ids → drop deleted users'
    );
    await repair(
        'projects',
        { representative_ids: { $elemMatch: { $nin: liveUserIds } } },
        { $pull: { representative_ids: { $nin: liveUserIds } } } as Document,
        'projects.representative_ids → drop deleted users'
    );
    await repair(
        'tasks',
        { assignee_ids: { $elemMatch: { $nin: liveUserIds } } },
        { $pull: { assignee_ids: { $nin: liveUserIds } } } as Document,
        'tasks.assignee_ids → drop deleted users'
    );
    await repair(
        'tasks',
        { primary_assignee_id: { $nin: [...liveUserIds, null] } },
        { $set: { primary_assignee_id: null } },
        'tasks.primary_assignee_id → null out deleted users'
    );
    await repair(
        'tasks',
        { collaborator_ids: { $elemMatch: { $nin: liveUserIds } } },
        { $pull: { collaborator_ids: { $nin: liveUserIds } } } as Document,
        'tasks.collaborator_ids → drop deleted users'
    );
    await repair(
        'companies',
        { parent_company_id: { $nin: [...keepCompanyIds, null] } },
        { $set: { parent_company_id: null } },
        'companies.parent_company_id → null out deleted parents'
    );
    // Comp-off lots keep their days (balances stay correct); only the dead
    // project pointer goes, so the accordion doesn't render a blank project.
    await repair(
        'comp_off_ledger',
        { project_id: { $nin: [...liveProjectIds, null] } },
        { $set: { project_id: null } },
        'comp_off_ledger.project_id → null out deleted projects'
    );

    // ---- report -----------------------------------------------------------
    console.log('ACTION                                                    ROWS');
    console.log('-'.repeat(66));
    let total = 0;
    for (const p of plan) {
        console.log(`${p.what.padEnd(56)} ${String(p.n).padStart(6)}`);
        if (!p.what.startsWith('repair:')) total += p.n;
    }
    console.log('-'.repeat(66));
    console.log(`${'TOTAL ROWS DELETED'.padEnd(56)} ${String(total).padStart(6)}`);
    console.log(COMMIT ? '\nApplied.' : '\nDry run — nothing was written. Re-run with --commit to apply.');

    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
