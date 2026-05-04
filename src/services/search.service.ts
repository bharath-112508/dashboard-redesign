import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { Sprint } from '../models/sprint.model.js';
import { Task } from '../models/task.model.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { type SearchType } from '../constants/search.js';
import { buildProjectVisibilityFilter } from './project.service.js';
import type { SearchQuery } from '../validators/search.validator.js';

/**
 * Global-search service (Step 32; API_Contract §13).
 *
 * Single endpoint, four parallel per-bucket queries. Each bucket runs in
 * parallel via `Promise.all` so the wall-time floor is the slowest single
 * collection, not the sum.
 *
 * Response shape mirrors API_Contract §13 verbatim — minimal fields for
 * typeahead navigation, NOT a power-user search. Specifically the user
 * bucket returns `{id, full_name, role}` only — `email` is NOT exposed
 * because the existing `GET /users` directory endpoint is gated to
 * admin+manager only. Surfacing email to employees here would regress
 * that contract; admins who want email-based lookup use `/users?q=`.
 *
 * Search-field choice (matches the response shape):
 *   - `users.full_name` only (NOT email — see above).
 *   - `projects.name` + `projects.code`.
 *   - `sprints.name`.
 *   - `tasks.title`.
 *
 * Visibility scoping:
 *   - **Admin / Manager** → no extra filter beyond the per-bucket
 *     "active / non-archived" gates.
 *   - **Employee** → projects (and their sprints + tasks) that have the
 *     caller in `member_ids`. Users bucket is open (internal directory).
 *   - **Client** → projects (and their sprints + tasks) that have the
 *     caller in `client_ids`. Users bucket is **always empty** for
 *     clients — the directory is internal-only.
 *
 * Regex injection guard: `q` is escaped before being inlined into a
 * `RegExp`. A literal `q = ".*"` would otherwise match every row and
 * blow past the per-bucket cap.
 *
 * Index alignment:
 *   - `users.full_name` isn't indexed; status pre-narrows the scan.
 *   - `projects` has indexes on `(status, is_archived)` and `code` is
 *     unique. Regex without anchor is a collection scan, bounded by
 *     `.limit()`.
 *   - `sprints` and `tasks` are filtered to `project_id ∈ visible` first
 *     (uses `{project_id: 1}` index), then regex'd against the remaining
 *     candidate rows — much smaller scan.
 */

// ─── Caller ─────────────────────────────────────────────────────────────

export interface SearchCaller {
    id: Types.ObjectId;
    role: RoleType;
}

// ─── Result types ──────────────────────────────────────────────────────

interface UserHit {
    id: string;
    full_name: string;
    role: string;
}

interface ProjectHit {
    id: string;
    name: string;
    code: string;
}

interface SprintHit {
    id: string;
    name: string;
    project_id: string;
}

interface TaskHit {
    id: string;
    title: string;
    project_id: string;
}

export interface SearchResult {
    users: UserHit[];
    projects: ProjectHit[];
    sprints: SprintHit[];
    tasks: TaskHit[];
}

// ─── Regex helpers ──────────────────────────────────────────────────────

/**
 * Escape every regex metacharacter so the user's literal query stays
 * literal. Without this, `q = ".*"` matches every row and blows past
 * the per-bucket cap; `q = "?"` is a syntax error that throws inside
 * the Mongo driver.
 *
 * Spec'd by MDN's "Escaping" example for `RegExp`.
 */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build a case-insensitive regex from a user-supplied literal string. */
const buildRegex = (q: string): RegExp => new RegExp(escapeRegex(q), 'i');

// ─── Bucket builders (per-type) ────────────────────────────────────────

/**
 * Resolve "which projects can this caller see at all" once per request.
 * Used as a hard prefilter for sprints + tasks so we never scan rows
 * for projects the caller wouldn't have visibility on.
 *
 * Returns `null` for admins/managers (no project-id filter needed —
 * they see every sprint / task regardless of project visibility).
 *
 * The list of visible project IDs is bounded by `SEARCH_MAX_LIMIT * N`
 * via the per-bucket cap, but realistically a user is on < 100 projects
 * so we don't bother capping the visible-id list itself.
 */
const resolveVisibleProjectIds = async (caller: SearchCaller): Promise<Types.ObjectId[] | null> => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER) return null;
    const filter = buildProjectVisibilityFilter(caller);
    const rows = await Project.find(filter).select('_id').lean<{ _id: Types.ObjectId }[]>();
    return rows.map((r) => r._id);
};

const searchUsers = async (q: RegExp, limit: number, caller: SearchCaller): Promise<UserHit[]> => {
    // Clients are explicitly excluded from the user-directory bucket.
    // Returning early avoids a wasted DB roundtrip.
    if (caller.role === ROLES.CLIENT) return [];

    // Search by `full_name` only. Email is intentionally NOT searchable
    // here because it isn't surfaced in the response shape (see file
    // header for the contract reasoning).
    const rows = await User.find({
        status: USER_STATUSES.ACTIVE,
        full_name: q,
    })
        .select('_id full_name role')
        .limit(limit)
        .lean<{ _id: Types.ObjectId; full_name: string; role: string }[]>();

    return rows.map((r) => ({
        id: r._id.toString(),
        full_name: r.full_name,
        role: r.role,
    }));
};

const searchProjects = async (q: RegExp, limit: number, caller: SearchCaller): Promise<ProjectHit[]> => {
    const filter: Record<string, unknown> = {
        ...buildProjectVisibilityFilter(caller),
        is_archived: false,
        $or: [{ name: q }, { code: q }],
    };

    const rows = await Project.find(filter)
        .select('_id name code')
        .limit(limit)
        .lean<{ _id: Types.ObjectId; name: string; code: string }[]>();

    return rows.map((r) => ({
        id: r._id.toString(),
        name: r.name,
        code: r.code,
    }));
};

const searchSprints = async (
    q: RegExp,
    limit: number,
    visibleProjectIds: Types.ObjectId[] | null
): Promise<SprintHit[]> => {
    // Empty visible-projects list → empty bucket; skip the DB call.
    if (visibleProjectIds && visibleProjectIds.length === 0) return [];

    const filter: Record<string, unknown> = { name: q };
    if (visibleProjectIds) filter.project_id = { $in: visibleProjectIds };

    const rows = await Sprint.find(filter)
        .select('_id name project_id')
        .limit(limit)
        .lean<{ _id: Types.ObjectId; name: string; project_id: Types.ObjectId }[]>();

    return rows.map((r) => ({
        id: r._id.toString(),
        name: r.name,
        project_id: r.project_id.toString(),
    }));
};

const searchTasks = async (
    q: RegExp,
    limit: number,
    visibleProjectIds: Types.ObjectId[] | null
): Promise<TaskHit[]> => {
    if (visibleProjectIds && visibleProjectIds.length === 0) return [];

    const filter: Record<string, unknown> = { title: q };
    if (visibleProjectIds) filter.project_id = { $in: visibleProjectIds };

    const rows = await Task.find(filter)
        .select('_id title project_id')
        .limit(limit)
        .lean<{ _id: Types.ObjectId; title: string; project_id: Types.ObjectId }[]>();

    return rows.map((r) => ({
        id: r._id.toString(),
        title: r.title,
        project_id: r.project_id.toString(),
    }));
};

// ─── Public entry point ─────────────────────────────────────────────────

const ALL_TYPES: readonly SearchType[] = ['users', 'projects', 'sprints', 'tasks'];

export const search = async (query: SearchQuery, caller: SearchCaller): Promise<SearchResult> => {
    const regex = buildRegex(query.q);
    // `types` is undefined when the caller didn't constrain — search
    // everything. Otherwise honour the explicit subset; the FE's
    // typeahead surface uses this to fetch only the bucket the active
    // tab needs.
    const wanted = new Set<SearchType>(query.types ?? ALL_TYPES);

    // The visible-id resolver is only needed to prefilter sprints and
    // tasks (the projects bucket has its own visibility filter built
    // straight from `buildProjectVisibilityFilter`). Skip the DB call
    // entirely when neither bucket is requested — saves one roundtrip
    // for the common `?types=users` typeahead.
    const needsVisibleIds = wanted.has('sprints') || wanted.has('tasks');
    const visibleProjectIds = needsVisibleIds ? await resolveVisibleProjectIds(caller) : null;

    const userPromise = wanted.has('users') ? searchUsers(regex, query.limit, caller) : Promise.resolve([]);
    const projectPromise = wanted.has('projects') ? searchProjects(regex, query.limit, caller) : Promise.resolve([]);
    const sprintPromise = wanted.has('sprints')
        ? searchSprints(regex, query.limit, visibleProjectIds)
        : Promise.resolve([]);
    const taskPromise = wanted.has('tasks') ? searchTasks(regex, query.limit, visibleProjectIds) : Promise.resolve([]);

    const [users, projects, sprints, tasks] = await Promise.all([
        userPromise,
        projectPromise,
        sprintPromise,
        taskPromise,
    ]);

    return { users, projects, sprints, tasks };
};

// Test seam: exported for direct unit-test access to the escaper.
export const __escapeRegex = escapeRegex;
