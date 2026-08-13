/**
 * Migration — backfill `Project.completed_at` for projects that were already
 * `completed` before the field existed.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass `--commit`.
 *
 *   npx tsx scripts/backfill-project-completed-at.ts             # plan only
 *   npx tsx scripts/backfill-project-completed-at.ts --commit    # apply
 *
 * What it does, per completed project with no `completed_at`:
 *   1. Looks for the audit row that RECORDED the completion — the newest
 *      `project.update` on this project whose `after.status === 'completed'`
 *      and `before.status !== 'completed'` — and takes that row's `created_at`.
 *      That is the real delivery moment, written at the time it happened.
 *   2. Finds nothing → leaves `completed_at` null. The project shows its
 *      progress bar and no on-time verdict.
 *
 * ── Why not fall back to `end_date`, like the sprint backfill does ────────
 *
 * `backfill-sprint-completed-at.ts` sets `completed_at = end_date` when there
 * is no evidence, reasoning that assuming a sprint closed on its planned date
 * is conservative because it reads as "on time". For a sprint that is fine.
 * Here it is not: `completed_at` vs `end_date` IS the on-time metric, so
 * defaulting the two to equal fabricates the exact number being measured, and
 * every historic project would report a flawless on-time record it never
 * earned. A missing verdict is honest; a manufactured one is worse than
 * nothing because someone will make a decision on it.
 *
 * If we later want more historic coverage, the answer is recovering rows from
 * the archived audit trail (`audit_archives`, Azure WORM), not guessing.
 *
 * Audit rows older than the `audit_archive` cron's retention have already been
 * moved to blob storage, so older projects legitimately land in case 2. The
 * script prints the split before you commit so the coverage is visible.
 *
 * Uses the native driver so Mongoose's timestamp plugin doesn't bump
 * `updated_at`. Re-runnable: only touches completed projects still missing the
 * field, so a second run is a clean no-op.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../src/constants/audit.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { PROJECT_STATUSES } from '../src/constants/project.js';

const COMMIT = process.argv.includes('--commit');

interface PendingProject {
    _id: mongoose.Types.ObjectId;
    name: string;
    end_date: string | null;
}

const main = async () => {
    await connectDB();
    const projects = mongoose.connection.db!.collection(COLLECTIONS.PROJECTS);
    const auditLogs = mongoose.connection.db!.collection(COLLECTIONS.AUDIT_LOGS);

    const filter = {
        status: PROJECT_STATUSES.COMPLETED,
        $or: [{ completed_at: { $exists: false } }, { completed_at: null }],
    };

    const totalDone = await projects.countDocuments({ status: PROJECT_STATUSES.COMPLETED });
    // Cast because `db.collection(name)` is untyped and `.project()` erases the
    // find generic — the shape is guaranteed by the projection on the next line.
    const pending = (await projects
        .find(filter, { projection: { name: 1, end_date: 1 } })
        .toArray()) as unknown as PendingProject[];

    console.log(`Completed projects: ${totalDone}. Missing completed_at: ${pending.length}.`);

    if (pending.length === 0) {
        console.log('Nothing to backfill — already up to date.');
        await disconnectDB();
        return;
    }

    // Resolve each project's completion moment from the audit trail. Served by
    // the {target_entity.kind, target_entity.id, created_at} index.
    const resolved: { project: PendingProject; completedAt: Date }[] = [];
    const unresolved: PendingProject[] = [];

    for (const project of pending) {
        const row = await auditLogs.findOne<{ created_at: Date }>(
            {
                action: AUDIT_ACTIONS.PROJECT_UPDATE,
                'target_entity.kind': AUDIT_TARGET_KINDS.PROJECT,
                'target_entity.id': project._id,
                'after.status': PROJECT_STATUSES.COMPLETED,
                'before.status': { $ne: PROJECT_STATUSES.COMPLETED },
            },
            { sort: { created_at: -1 }, projection: { created_at: 1 } }
        );
        if (row?.created_at) resolved.push({ project, completedAt: row.created_at });
        else unresolved.push(project);
    }

    console.log(
        `\nAudit evidence found for ${resolved.length} of ${pending.length}. ` +
            `${unresolved.length} will stay null (no verdict shown for those).`
    );

    if (!COMMIT) {
        console.log('\nDRY RUN — would set completed_at from the audit trail for (first 10 shown):');
        for (const r of resolved.slice(0, 10)) {
            console.log(`  • ${r.project.name} → ${r.completedAt.toISOString()} (target ${r.project.end_date})`);
        }
        if (unresolved.length > 0) {
            console.log('\nLeft null — no surviving audit row (first 10 shown):');
            for (const p of unresolved.slice(0, 10)) console.log(`  • ${p.name}`);
        }
        console.log(`\nRe-run with --commit to apply ${resolved.length} update(s).`);
        await disconnectDB();
        return;
    }

    if (resolved.length === 0) {
        console.log('No audit evidence for any pending project — nothing to write.');
        await disconnectDB();
        return;
    }

    const result = await projects.bulkWrite(
        resolved.map((r) => ({
            updateOne: {
                // Re-assert the filter so a concurrent run can't double-write.
                filter: { _id: r.project._id, ...filter },
                update: { $set: { completed_at: r.completedAt } },
            },
        }))
    );
    console.log(`Committed. Matched ${result.matchedCount}, modified ${result.modifiedCount}.`);
    if (unresolved.length > 0) {
        console.log(`${unresolved.length} project(s) left with completed_at = null, as designed.`);
    }

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
