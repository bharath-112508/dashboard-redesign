/**
 * READ-ONLY demo coverage check per role — focuses on whether CLIENTS are
 * wired into projects/tasks (they have no attendance/timesheets/leaves), plus a
 * quick per-role data presence summary. Run: npx tsx scripts/dev-demo-rolecheck.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { Project } from '../src/models/project.model.js';
import { Task } from '../src/models/task.model.js';

async function main() {
    await connectDB();

    const clients = await User.find({ role: 'client', status: 'active' })
        .select('_id full_name email')
        .lean<{ _id: any; full_name: string; email: string }[]>();

    console.log(`\n=== CLIENT coverage (${clients.length} active clients) ===`);
    for (const c of clients) {
        const projs = await Project.find({ client_ids: c._id }).select('name code').lean<{ name: string; code: string }[]>();
        const projIds = (await Project.find({ client_ids: c._id }).select('_id').lean<{ _id: any }[]>()).map((p) => p._id);
        const taskCount = projIds.length ? await Task.countDocuments({ project_id: { $in: projIds } }) : 0;
        console.log(
            `  ${c.full_name.padEnd(20)} ${c.email.padEnd(28)} projects: ${projs.length} [${projs
                .map((p) => p.code ?? p.name)
                .join(', ')}] · tasks visible: ${taskCount}`,
        );
    }

    console.log(`\n=== Per-role data presence ===`);
    const roles = ['admin', 'manager', 'team_lead', 'employee', 'client'] as const;
    for (const role of roles) {
        const us = await User.find({ role, status: 'active' })
            .select('_id full_name')
            .lean<{ _id: any; full_name: string }[]>();
        let assignedTasks = 0;
        let memberProjects = 0;
        for (const u of us) {
            assignedTasks += await Task.countDocuments({ primary_assignee_id: u._id });
            memberProjects += await Project.countDocuments({ $or: [{ member_ids: u._id }, { client_ids: u._id }] });
        }
        console.log(
            `  ${role.padEnd(10)} users ${us.length} · assigned tasks (sum) ${assignedTasks} · project memberships (sum) ${memberProjects}`,
        );
    }

    console.log(`\n=== Projects → rosters ===`);
    const projects = await Project.find({})
        .select('name code member_ids client_ids')
        .lean<{ name: string; code: string; member_ids: any[]; client_ids: any[] }[]>();
    for (const p of projects) {
        console.log(
            `  ${(p.code ?? p.name).padEnd(14)} members ${p.member_ids?.length ?? 0} · clients ${p.client_ids?.length ?? 0}`,
        );
    }

    await disconnectDB();
}

main().catch(async (e) => {
    console.error(e);
    await disconnectDB();
    process.exit(1);
});
