/**
 * Pure plan for adding the `bug` built-in to stored project orders (see
 * `scripts/migrate-bug-status.ts`). A project that already has `bug` is done;
 * one with a CUSTOM status keyed `bug` is a conflict to resolve by hand.
 */
export const planBugStatusMigration = (
    projects: Array<{
        _id: string;
        name: string;
        default_status_orders?: Array<{ key: string }>;
        custom_task_statuses?: Array<{ key: string }>;
    }>
): { toUpdate: string[]; alreadyDone: number; conflicts: Array<{ id: string; name: string }> } => {
    const plan = { toUpdate: [] as string[], alreadyDone: 0, conflicts: [] as Array<{ id: string; name: string }> };
    for (const pr of projects) {
        // Custom first: a stray built-in next to a custom `bug` is still a conflict.
        if ((pr.custom_task_statuses ?? []).some((c) => c.key === 'bug')) {
            plan.conflicts.push({ id: String(pr._id), name: pr.name });
        } else if ((pr.default_status_orders ?? []).some((o) => o.key === 'bug')) {
            plan.alreadyDone += 1;
        } else {
            plan.toUpdate.push(String(pr._id));
        }
    }
    return plan;
};
