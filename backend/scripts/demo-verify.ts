/**
 * READ-ONLY integrity check after the prune. Walks the FK graph and reports
 * any reference that no longer resolves — the things that render as blanks,
 * "undefined", or a 404 in the middle of a demo.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const db = mongoose.connection.db!;

    const idsOf = async (c: string): Promise<Set<string>> =>
        new Set(
            (
                await db
                    .collection(c)
                    .find({}, { projection: { _id: 1 } })
                    .toArray()
            ).map((d) => String(d._id))
        );

    const live = {
        users: await idsOf('users'),
        companies: await idsOf('companies'),
        projects: await idsOf('projects'),
        tasks: await idsOf('tasks'),
        sprints: await idsOf('sprints'),
        stories: await idsOf('stories'),
    };

    /** [collection, field, target] — dotted paths and `[]` for arrays. */
    const checks: Array<[string, string, keyof typeof live]> = [
        ['projects', 'company_id', 'companies'],
        ['projects', 'member_ids[]', 'users'],
        ['projects', 'representative_ids[]', 'users'],
        ['tasks', 'project_id', 'projects'],
        ['tasks', 'sprint_id', 'sprints'],
        ['tasks', 'story_id', 'stories'],
        ['tasks', 'parent_task_id', 'tasks'],
        ['tasks', 'assignee_ids[]', 'users'],
        ['tasks', 'primary_assignee_id', 'users'],
        ['tasks', 'collaborator_ids[]', 'users'],
        ['tasks', 'created_by', 'users'],
        ['sprints', 'project_id', 'projects'],
        ['stories', 'project_id', 'projects'],
        ['timesheet_entries', 'project_id', 'projects'],
        ['timesheet_entries', 'task_id', 'tasks'],
        ['timesheet_entries', 'user_id', 'users'],
        ['task_comments', 'task_id', 'tasks'],
        ['task_activities', 'task_id', 'tasks'],
        ['task_attachments', 'task_id', 'tasks'],
        ['billing_rates', 'project_id', 'projects'],
        ['billing_rates', 'user_id', 'users'],
        ['project_share_links', 'project_id', 'projects'],
        ['project_share_links', 'owner_client_id', 'users'],
        ['users', 'client_profile.company_id', 'companies'],
        ['engagements', 'company_id', 'companies'],
        ['invoices', 'company_id', 'companies'],
        ['leave_requests', 'user_id', 'users'],
        ['leave_balances', 'user_id', 'users'],
        ['attendance_records', 'user_id', 'users'],
        ['comp_off_ledger', 'user_id', 'users'],
        ['comp_off_ledger', 'project_id', 'projects'],
        ['notifications', 'user_id', 'users'],
        ['client_health', 'company_id', 'companies'],
        ['client_raci_assignments', 'company_id', 'companies'],
        ['contract_versions', 'company_id', 'companies'],
        ['escalation_paths', 'company_id', 'companies'],
        ['governance_meetings', 'company_id', 'companies'],
        ['payroll_profiles', 'user_id', 'users'],
        ['salary_structures', 'user_id', 'users'],
    ];

    let bad = 0;
    for (const [coll, field, target] of checks) {
        const isArr = field.endsWith('[]');
        const path = isArr ? field.slice(0, -2) : field;
        const rows = await db
            .collection(coll)
            .find({}, { projection: { [path]: 1 } })
            .toArray();
        const missing: string[] = [];
        for (const r of rows) {
            const v = path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], r);
            if (v == null) continue;
            for (const one of Array.isArray(v) ? v : [v]) {
                if (one != null && !live[target].has(String(one))) missing.push(String(one));
            }
        }
        if (missing.length) {
            bad += missing.length;
            console.log(
                `DANGLING  ${coll}.${field} → ${target}: ${missing.length} bad ref(s)  e.g. ${[...new Set(missing)].slice(0, 3).join(', ')}`
            );
        }
    }

    // Notification deep-links that would 404.
    const notifs = await db.collection('notifications').find({}).toArray();
    const allLive = new Set([...live.tasks, ...live.projects]);
    const deadLinks = notifs.filter(
        (n) =>
            ['task', 'project'].includes(n.related_entity?.kind) &&
            n.related_entity?.id &&
            !allLive.has(String(n.related_entity.id))
    );
    if (deadLinks.length) {
        bad += deadLinks.length;
        console.log(`DANGLING  notifications.related_entity → task/project: ${deadLinks.length}`);
    }

    console.log(bad === 0 ? '\nOK — no dangling references found.' : `\n${bad} dangling reference(s).`);
    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
