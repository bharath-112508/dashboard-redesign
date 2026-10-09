import { Types } from 'mongoose';

import { Sprint } from '../models/sprint.model.js';
import { Task } from '../models/task.model.js';
import { TIMELINE_TASK_CAP, TIMELINE_UNDATED_CAP } from '../constants/timeline.js';
import { DEFAULT_TASK_STATUSES } from '../constants/task.js';
import { loadProjectForCaller } from './project.service.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { RoleType } from '../constants/roles.js';
import type { TimelineQuery } from '../validators/timeline.validator.js';

/**
 * Timeline / Gantt service (Phase 4 Step 41).
 *
 * One read-only entry point: `buildTimeline(projectId, query, caller)`.
 * Returns the project + its sprints (whose ranges overlap the window)
 * + tasks shaped for Gantt rendering. The caller's project visibility
 * is enforced via `loadProjectForCaller` — admins/managers see any
 * project; employees see member-of; clients see client-of. The 404 →
 * 403 mapping inside `loadProjectForCaller` keeps existence-probing
 * blocked.
 *
 * Derived start date — v1 doesn't add a `task.start_date` column to
 * the existing model. Instead the service derives it per task:
 *   1. If the task has a `sprint_id` and that sprint is loaded,
 *      use the sprint's `start_date`.
 *   2. Otherwise fall back to the task's `created_at` (YYYY-MM-DD).
 *
 * Overlap filter — DB-side: `due_date >= from_date` anchors the bar's
 * right edge to be in or after the window. JS-side after derivation:
 * `derived_start <= to_date` anchors the bar's left edge to be in or
 * before the window. Together this catches every task whose [start,
 * due] interval overlaps the window.
 */

export interface TimelineCaller {
    id: Types.ObjectId;
    role: RoleType;
}

interface TimelineProject {
    id: string;
    name: string;
    start_date: string;
    end_date: string | null;
}

interface TimelineSprint {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    status: string;
}

interface TimelineTask {
    id: string;
    title: string;
    status: string;
    priority: string;
    /** Derived per the fallback chain above. */
    start_date: string;
    due_date: string;
    sprint_id: string | null;
    story_id: string | null;
    parent_task_id: string | null;
    primary_assignee_id: string | null;
    depends_on_task_ids: string[];
    /** Surface the explicit position for stable ordering within a group. */
    position: number;
}

export interface TimelineResult {
    project: TimelineProject;
    sprints: TimelineSprint[];
    tasks: TimelineTask[];
    /** Tasks with no due date (no bar), capped at `TIMELINE_UNDATED_CAP`. */
    undated: Array<{
        id: string;
        title: string;
        status: string;
        priority: string;
        sprint_id: string | null;
        story_id: string | null;
        primary_assignee_id: string | null;
    }>;
    /** True when the task list was truncated at `TIMELINE_TASK_CAP`. */
    truncated: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const toIstDate = (d: Date): string => dayjs(d).tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

// ─── Public entry point ────────────────────────────────────────────────

export const buildTimeline = async (
    projectId: Types.ObjectId,
    query: TimelineQuery,
    caller: TimelineCaller
): Promise<TimelineResult> => {
    const project = await loadProjectForCaller(projectId, caller);

    // Sprints whose range overlaps the window: a sprint is "in window"
    // if `start_date <= to_date AND end_date >= from_date`. Both fields
    // are required strings on the sprint model so the scan is index-
    // friendly via `{project_id, start_date}`.
    const sprintRows = await Sprint.find({
        project_id: projectId,
        start_date: { $lte: query.to_date },
        end_date: { $gte: query.from_date },
    })
        .select('_id name start_date end_date status')
        .sort({ start_date: 1 })
        .lean<
            {
                _id: Types.ObjectId;
                name: string;
                start_date: string;
                end_date: string;
                status: string;
            }[]
        >();

    const sprintsById = new Map(sprintRows.map((s) => [s._id.toString(), s]));

    // Tasks: DB-side filter on `due_date >= from_date` (uses the
    // existing `{project_id, due_date}` index) plus optional sprint /
    // story / completed-status filters. JS-side filter on derived
    // start <= to_date after we've enriched each task with its sprint
    // start_date. Hard cap at `TIMELINE_TASK_CAP + 1` so we can detect
    // truncation cleanly.
    const taskFilter: Record<string, unknown> = {
        project_id: projectId,
        due_date: { $gte: query.from_date },
    };
    if (query.sprint_id) taskFilter.sprint_id = new Types.ObjectId(query.sprint_id);
    if (query.story_id) taskFilter.story_id = new Types.ObjectId(query.story_id);
    if (!query.include_completed) {
        taskFilter.status = { $ne: DEFAULT_TASK_STATUSES.DONE };
    }

    const taskRows = await Task.find(taskFilter)
        .select(
            '_id title status priority due_date sprint_id story_id parent_task_id ' +
                'primary_assignee_id depends_on_task_ids position created_at'
        )
        .sort({ position: 1, created_at: 1 })
        .limit(TIMELINE_TASK_CAP + 1)
        .lean<
            {
                _id: Types.ObjectId;
                title: string;
                status: string;
                priority: string;
                due_date: string;
                sprint_id: Types.ObjectId | null;
                story_id: Types.ObjectId | null;
                parent_task_id: Types.ObjectId | null;
                primary_assignee_id: Types.ObjectId | null;
                depends_on_task_ids: Types.ObjectId[];
                position: number;
                created_at: Date;
            }[]
        >();

    // Tasks with no due date can't be drawn as bars; list them separately so
    // they don't vanish from the timeline (same sprint/epic/done filters).
    const { due_date: _ignored, ...undatedFilter } = taskFilter;
    const undatedRows = await Task.find({ ...undatedFilter, due_date: null })
        .select('_id title status priority sprint_id story_id primary_assignee_id')
        .sort({ position: 1, created_at: 1 })
        .limit(TIMELINE_UNDATED_CAP)
        .lean<
            {
                _id: Types.ObjectId;
                title: string;
                status: string;
                priority: string;
                sprint_id: Types.ObjectId | null;
                story_id: Types.ObjectId | null;
                primary_assignee_id: Types.ObjectId | null;
            }[]
        >();

    const truncated = taskRows.length > TIMELINE_TASK_CAP;
    const candidates = truncated ? taskRows.slice(0, TIMELINE_TASK_CAP) : taskRows;

    // Derive start_date per task + apply the JS-side window-left filter.
    const tasks: TimelineTask[] = [];
    for (const t of candidates) {
        let startDate: string;
        if (t.sprint_id) {
            const sprint = sprintsById.get(t.sprint_id.toString());
            startDate = sprint ? sprint.start_date : toIstDate(t.created_at);
        } else {
            startDate = toIstDate(t.created_at);
        }

        // Skip tasks whose entire bar is to the left of the window.
        if (startDate > query.to_date) continue;

        tasks.push({
            id: t._id.toString(),
            title: t.title,
            status: t.status,
            priority: t.priority,
            start_date: startDate,
            due_date: t.due_date,
            sprint_id: t.sprint_id?.toString() ?? null,
            story_id: t.story_id?.toString() ?? null,
            parent_task_id: t.parent_task_id?.toString() ?? null,
            primary_assignee_id: t.primary_assignee_id?.toString() ?? null,
            depends_on_task_ids: t.depends_on_task_ids.map((id) => id.toString()),
            position: t.position,
        });
    }

    return {
        project: {
            id: project._id.toString(),
            name: project.name,
            start_date: project.start_date,
            end_date: project.end_date,
        },
        sprints: sprintRows.map((s) => ({
            id: s._id.toString(),
            name: s.name,
            start_date: s.start_date,
            end_date: s.end_date,
            status: s.status,
        })),
        tasks,
        truncated,
        undated: (undatedRows ?? []).map((t) => ({
            id: t._id.toString(),
            title: t.title,
            status: t.status,
            priority: t.priority,
            sprint_id: t.sprint_id?.toString() ?? null,
            story_id: t.story_id?.toString() ?? null,
            primary_assignee_id: t.primary_assignee_id?.toString() ?? null,
        })),
    };
};
