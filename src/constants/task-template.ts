/**
 * Task-template constants (Phase 4 Step 40 — `/projects/:id/task-templates`,
 * `/task-templates/:id`).
 *
 * One unified model handles BOTH manual templates AND recurring tasks —
 * recurrence is an optional sub-doc on the template row. A template
 * with `recurrence.enabled: false` is "click to instantiate manually";
 * with `recurrence.enabled: true` it becomes the daily cron's input.
 *
 * Reference resilience (instantiation): templates capture defaults
 * for assignee / collaborators / story / sprint at creation time. When
 * the cron — or a manual instantiate — fires, those references are
 * **revalidated**. References that no longer satisfy the project's
 * membership rules are silently dropped (logged at warn) so a single
 * deactivated user can't break a recurring weekly status-update
 * template that names them as a collaborator.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── RBAC ───────────────────────────────────────────────────────────────
//
// Write = admin + manager (same as project task writes).
// Read  = admin + manager + employee. **Clients are deliberately
// excluded** — templates capture internal team process (e.g.
// "Internal QA review checklist", "Sprint retrospective doc") and
// surfacing them to externals leaks workflow patterns. Clients still
// see the resulting INSTANTIATED tasks via the regular task list
// (that's the point — they see work in progress for their projects),
// but they don't see the team's process patterns.

export const TASK_TEMPLATE_WRITE_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER];
export const TASK_TEMPLATE_READ_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE];

// ─── Field caps ─────────────────────────────────────────────────────────

export const TASK_TEMPLATE_NAME_MAX = 200;
export const TASK_TEMPLATE_DESCRIPTION_MAX = 5000;
export const TASK_TEMPLATE_TITLE_MAX = 200;
export const TASK_TEMPLATE_DUE_OFFSET_MAX_DAYS = 365;

// ─── Recurrence frequencies ────────────────────────────────────────────
//
// `weekly` carries a `weekdays: number[]` (0=Sun..6=Sat); `monthly`
// carries a `day_of_month: 1..28`. Capping at 28 sidesteps the "what
// happens to a day-of-month=31 schedule in February" UX trap — a v1
// design constraint we'd reconsider if customer demand surfaces.

export const TASK_TEMPLATE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type TaskTemplateFrequency = (typeof TASK_TEMPLATE_FREQUENCIES)[number];

export const TASK_TEMPLATE_DAY_OF_MONTH_MAX = 28;

// ─── Recurrence sweep cap ──────────────────────────────────────────────
//
// One cron tick processes at most this many templates. Defence
// against a misconfiguration where dozens of recurring templates all
// fire on the same day — bounds wall time per tick. 100 is comfortably
// above any realistic single-org workload (a busy product team with
// 20 weekly recurring + 5 monthly recurring + 10 daily recurring is
// 35 templates per day max).

export const TASK_TEMPLATE_RECURRENCE_MAX_PER_RUN = 100;

// ─── List endpoint pagination ──────────────────────────────────────────

export const TASK_TEMPLATE_LIST_DEFAULT_LIMIT = 20;
export const TASK_TEMPLATE_LIST_MAX_LIMIT = 100;
