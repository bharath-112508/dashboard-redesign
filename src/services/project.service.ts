import { Types } from 'mongoose';

import { Company } from '../models/company.model.js';
import { Project, type ProjectDocument, type CustomTaskStatus } from '../models/project.model.js';
import { Sprint } from '../models/sprint.model.js';
import { Story } from '../models/story.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { deriveProjectCodeBase, pickProjectCode } from '../utils/project-code.js';
import { pickCustomStatusKey, slugifyCustomStatusKey } from '../utils/custom-status-key.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
    DEFAULT_TASK_STATUS_KEYS,
    PROJECT_CLIENT_SIDE_ROLES,
    PROJECT_COMPANY_SCOPED_ROLES,
    PROJECT_MEMBER_SCOPED_ROLES,
    PROJECT_REPRESENTATIVE_SCOPED_ROLES,
    type ProjectStatus,
} from '../constants/project.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateCustomStatusBody,
    CreateProjectBody,
    ListProjectsQuery,
    PatchCustomStatusBody,
    PatchProjectBody,
    ProjectRepresentativesBulkBody,
    ProjectMembersBulkBody,
} from '../validators/project.validator.js';

/**
 * Project service — Data_Model.md §5.1 / API_Contract.md §7.1.
 *
 * Threading model:
 *  - Every write takes an `audit?: AuditContext` so the controller can pass
 *    the request-scoped actor + IP/UA snapshot. We DON'T require it (audits
 *    are best-effort, and unit tests would hate having to fabricate one), but
 *    we always fire when it's present.
 *  - Reads are scoped by `caller`. Admins/managers see everything; employees
 *    see projects where `member_ids ∋ caller.id`; a `client` (the company-level
 *    role) sees every project where `company_id === their company`; a
 *    `representative` sees only projects where `representative_ids ∋ caller.id`.
 *    The single `buildVisibilityFilter` helper is the one place this rule
 *    lives — every read that must respect visibility composes it into its
 *    filter, and `assertCallerCanRead` must mirror it exactly or a list and a
 *    get would answer differently for the same caller.
 *
 * Member/client semantics:
 *  - `add` and `remove` are computed against the existing array so the bulk
 *    endpoint is idempotent: re-running the same payload converges on the
 *    same end-state. We dedupe + ignore unknown removes so the FE can fire
 *    "remove these 5 IDs" without having to inspect the current array first.
 *  - `add` candidates are validated against the `users` collection: members
 *    must be active internal users (admin/manager/employee); representatives
 *    must be active client-side users **belonging to this project's company**
 *    (the company half is what stops company B's person being rostered onto
 *    company A's project). Mismatches throw 422 INVALID_PROJECT_*_ROLE so the
 *    admin sees exactly which IDs are wrong.
 *
 * Custom statuses:
 *  - `key` collisions with the four implicit defaults (`to_do` / `in_progress`
 *    / `review` / `done`) are rejected at the validator layer; key collisions
 *    *within the project* are rejected here.
 *  - Deletion refuses (R3 — `RESOURCE_HAS_DEPENDENTS`) when any task in the
 *    project still references the status. The admin's recourse is to PATCH
 *    each affected task onto a different status first, then re-issue the
 *    delete. The check is a single `Task.countDocuments({project_id, status})`.
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface ProjectCaller {
    id: Types.ObjectId;
    role: RoleType;
    /**
     * Optional Step-47 RBAC signal (BACKEND_AUDIT.md R4). When present,
     * service-layer admin checks via `isAdminLike(caller)` recognise a
     * user as admin through `role_keys.includes('admin')` even when the
     * legacy `role` cache is a different role. Controllers should pass
     * `req.user.role_keys` whenever the caller carries it.
     */
    role_keys?: readonly string[];
    /**
     * The caller's company — present only for client-side roles
     * (`client` / `representative`). Sourced from the DB row that
     * `authenticate` already reads, never from the JWT (a reassigned
     * client would otherwise keep their old company until the token
     * expired).
     *
     * A `client`'s project visibility is driven by THIS field, not by
     * `representative_ids`. Clients are also listed on the roster so the
     * project's client-side roster is one explicit field, but that entry
     * is a denormalised convenience: if it ever drifts, the Client still
     * sees their projects. Drift costs display accuracy, never access.
     */
    company_id?: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Visibility scoping ──────────────────────────────────────────────────

/**
 * A filter that matches nothing. Used for "this caller sees no projects"
 * so an unmapped role — or a client-side caller with no company — gets
 * zero rows rather than the whole collection.
 */
const DENY_ALL: Record<string, unknown> = { _id: new Types.ObjectId('000000000000000000000000') };

/**
 * Step 47: Manager + Admin see every project; **Team Lead** + Employee
 * see only projects where they appear in `member_ids`. Team Leads are
 * project authors within projects they belong to (the legacy
 * project-member scoping is the same — the difference is purely
 * authoring permissions, which the route layer gates separately).
 */
const buildVisibilityFilter = (caller: ProjectCaller): Record<string, unknown> => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER) return {};
    if (PROJECT_MEMBER_SCOPED_ROLES.includes(caller.role)) return { member_ids: caller.id };
    // A `client` is the company-level role: every project of their company,
    // authoritatively by company_id (NOT by roster containment).
    if (PROJECT_COMPANY_SCOPED_ROLES.includes(caller.role)) {
        // A client-side caller with no company can see nothing. Falling back
        // to `{}` here would hand them the whole org.
        if (!caller.company_id) return DENY_ALL;
        return { company_id: caller.company_id };
    }
    // A `representative` is roster-scoped: only projects they're assigned to.
    if (PROJECT_REPRESENTATIVE_SCOPED_ROLES.includes(caller.role)) {
        return { representative_ids: caller.id };
    }
    // Defence in depth — any future role we forget to map gets no visibility
    // rather than implicit access to everything.
    return DENY_ALL;
};

const assertCallerCanRead = (project: ProjectDocument, caller: ProjectCaller): void => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER) return;
    const has = (arr: Types.ObjectId[]): boolean => arr.some((u) => u.equals(caller.id));
    if (PROJECT_MEMBER_SCOPED_ROLES.includes(caller.role) && has(project.member_ids)) return;
    // Mirrors buildVisibilityFilter exactly — if these two ever disagree, a
    // list and a get would answer differently for the same caller.
    if (
        PROJECT_COMPANY_SCOPED_ROLES.includes(caller.role) &&
        caller.company_id &&
        project.company_id &&
        project.company_id.equals(caller.company_id)
    ) {
        return;
    }
    if (PROJECT_REPRESENTATIVE_SCOPED_ROLES.includes(caller.role) && has(project.representative_ids)) {
        return;
    }
    throw AppError.forbidden('You do not have access to this project', ERROR_CODES.FORBIDDEN);
};

// ─── Serialisation ───────────────────────────────────────────────────────

const toPublic = (doc: ProjectDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

/**
 * Resolve `company_id` → `company: {id, name} | null` for a page of projects.
 *
 * This has to happen server-side. `company_id` alone is useless to most of
 * the UI because `company.read` is Manager+ — a Team Lead or Employee asking
 * the companies endpoint for the name would get a 403, so the projects list
 * would silently lose the client column for exactly the roles that live in
 * it. Shipping the name with the row is also what keeps this from becoming
 * an N+1: one `$in` covers the whole page.
 *
 * `null` is a real, expected value — an internal project has no client
 * company — and is NOT the same as "company deleted". A company is archived,
 * never hard-deleted (projects point at it), so a dangling id would be a bug;
 * it degrades to `null` here rather than throwing, since a stale pointer
 * shouldn't take down the whole list.
 */
const attachCompanies = async (rows: ProjectDocument[]): Promise<Map<string, { id: string; name: string }>> => {
    const ids = [
        ...new Set(
            rows
                .map((r) => r.company_id)
                .filter((id): id is Types.ObjectId => Boolean(id))
                .map(String)
        ),
    ];
    if (ids.length === 0) return new Map();
    const companies = await Company.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
        .select('_id name')
        .lean<{ _id: Types.ObjectId; name: string }[]>();
    return new Map(companies.map((c) => [String(c._id), { id: String(c._id), name: c.name }]));
};

/** The `company` field as it appears on a project response. */
const companyOf = (
    doc: ProjectDocument,
    byId: Map<string, { id: string; name: string }>
): { id: string; name: string } | null => (doc.company_id ? (byId.get(String(doc.company_id)) ?? null) : null);

// ─── Member / client role validation ─────────────────────────────────────

const INTERNAL_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];

const validateMemberCandidates = async (ids: Types.ObjectId[]): Promise<void> => {
    if (ids.length === 0) return;
    const found = await User.find({ _id: { $in: ids }, status: USER_STATUSES.ACTIVE })
        .select('_id role')
        .lean<{ _id: Types.ObjectId; role: RoleType }[]>();
    const okIds = new Set<string>();
    for (const u of found) {
        if (INTERNAL_ROLES.includes(u.role)) okIds.add(String(u._id));
    }
    const bad = ids.filter((id) => !okIds.has(String(id))).map((id) => id.toString());
    if (bad.length > 0) {
        throw AppError.unprocessable(
            "One or more of the selected people aren't active team members.",
            ERROR_CODES.INVALID_PROJECT_MEMBER_ROLE,
            { invalid_user_ids: bad }
        );
    }
};

/**
 * Roster invariant: every id on `representative_ids` must be an ACTIVE
 * client-side user (`client` or `representative`) belonging to THIS
 * project's company.
 *
 * The company check is the load-bearing half. Without it, a project could
 * roster a representative from another company — handing company B's
 * person access to company A's project.
 */
const validateRepresentativeCandidates = async (
    ids: Types.ObjectId[],
    companyId: Types.ObjectId | null
): Promise<void> => {
    if (ids.length === 0) return;

    if (!companyId) {
        throw AppError.unprocessable(
            'This project has no client company, so it cannot have representatives. Set company_id first.',
            ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            { invalid_user_ids: ids.map((id) => id.toString()) }
        );
    }

    const found = await User.find({
        _id: { $in: ids },
        status: USER_STATUSES.ACTIVE,
        role: { $in: PROJECT_CLIENT_SIDE_ROLES },
        'client_profile.company_id': companyId,
    })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>();
    const okIds = new Set<string>(found.map((u) => String(u._id)));
    const bad = ids.filter((id) => !okIds.has(String(id))).map((id) => id.toString());
    if (bad.length > 0) {
        throw AppError.unprocessable(
            "One or more user_ids aren't active representatives of this project's company",
            ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            { invalid_user_ids: bad }
        );
    }
};

/**
 * The company's `client`-role people, who are auto-rostered onto every
 * project of their company.
 *
 * This keeps the project's client-side roster explicit in one field. It is
 * a denormalised convenience only — a Client's ACCESS comes from
 * `company_id` (see the model docblock), so if this seeding is ever missed
 * they still see the project. Display accuracy can drift; access cannot.
 */
const companyClientIds = async (companyId: Types.ObjectId | null): Promise<Types.ObjectId[]> => {
    if (!companyId) return [];
    const rows = await User.find({
        role: ROLES.CLIENT,
        status: USER_STATUSES.ACTIVE,
        'client_profile.company_id': companyId,
    })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>();
    return rows.map((r) => r._id);
};

const dedupeObjectIds = (ids: string[]): Types.ObjectId[] => {
    const seen = new Set<string>();
    const out: Types.ObjectId[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(new Types.ObjectId(id));
    }
    return out;
};

// ─── E11000 → PROJECT_CODE_TAKEN ─────────────────────────────────────────

const isCodeDuplicateError = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: number; keyPattern?: Record<string, unknown> };
    return e.code === 11000 && Boolean(e.keyPattern?.code);
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Derive a unique project `code` from the name. Reads the codes already
 * using this base prefix (`WR`, `WR2`, …) in one query, then picks the first
 * free one. A concurrent create could still race us to the same code — the
 * unique index is the real guard, and `createProject` retries on that 11000.
 */
const generateUniqueProjectCode = async (name: string): Promise<string> => {
    const base = deriveProjectCodeBase(name);
    const prefixRegex = new RegExp(`^${escapeRegExp(base)}[0-9]*$`, 'i');
    const rows = await Project.find({ code: prefixRegex }).select('code').lean<{ code: string }[]>();
    return pickProjectCode(base, new Set(rows.map((r) => r.code)));
};

// ─── POST /projects ──────────────────────────────────────────────────────

export const createProject = async (
    input: CreateProjectBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const memberIds = dedupeObjectIds(input.member_ids);
    const companyId = input.company_id ? new Types.ObjectId(input.company_id) : null;
    const representativeIds = dedupeObjectIds(input.representative_ids);

    // BUG-007 — visibility for non-admin/manager callers is scoped to
    // `member_ids` (team_lead / employee). If a Team Lead creates a
    // project without explicitly adding themselves to the member list,
    // they instantly lose visibility of the project they just made.
    // Auto-add the creator to member_ids when they're a member-scoped
    // role so they always see their own project in GET /projects.
    // Admins/Managers bypass the visibility filter, so we don't
    // pollute member_ids with their IDs.
    if (PROJECT_MEMBER_SCOPED_ROLES.includes(caller.role) && !memberIds.some((id) => id.equals(caller.id))) {
        memberIds.push(caller.id);
    }

    await validateMemberCandidates(memberIds);
    await validateRepresentativeCandidates(representativeIds, companyId);

    // Seed the roster with the company's `client`-role people so the
    // project's client-side roster is complete from the moment it exists.
    // Access-wise this is redundant (they're company-scoped), which is
    // exactly why a miss here is survivable — see the model docblock.
    for (const id of await companyClientIds(companyId)) {
        if (!representativeIds.some((r) => r.equals(id))) representativeIds.push(id);
    }

    // Code is auto-generated from the name when the caller omits it (the
    // common path — the create form no longer asks for one). An explicitly
    // supplied code is honoured and its collision surfaces to the user.
    const autoCode = !input.code;
    let code = input.code ?? (await generateUniqueProjectCode(input.name));

    let created: ProjectDocument | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            created = await Project.create({
                name: input.name,
                code,
                description: input.description,
                start_date: input.start_date,
                end_date: input.end_date,
                status: input.status,
                member_ids: memberIds,
                company_id: companyId,
                representative_ids: representativeIds,
                custom_task_statuses: input.custom_task_statuses,
                created_by: caller.id,
            });
            break;
        } catch (err) {
            if (!isCodeDuplicateError(err)) throw err;
            // A user-supplied code that clashes is a real conflict to report.
            if (!autoCode) {
                throw AppError.conflict('A project with this code already exists', ERROR_CODES.PROJECT_CODE_TAKEN, {
                    code,
                });
            }
            // An auto-generated code lost a race — recompute against the now
            // newer set and retry.
            code = await generateUniqueProjectCode(input.name);
        }
    }
    if (!created) {
        throw AppError.conflict('Could not allocate a unique project code', ERROR_CODES.PROJECT_CODE_TAKEN, {
            code,
        });
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: created._id },
            after: toPublic(created),
        });
    }

    return toPublic(created);
};

// ─── GET /projects ───────────────────────────────────────────────────────

export const listProjects = async (
    query: ListProjectsQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = { ...buildVisibilityFilter(caller) };

    if (query.status) filter.status = query.status;
    if (query.is_archived !== undefined) filter.is_archived = query.is_archived;

    // Admins/managers can additionally filter by membership.
    if (query.member_id) filter.member_ids = new Types.ObjectId(query.member_id);
    if (query.company_id) filter.company_id = new Types.ObjectId(query.company_id);

    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
            { name: { $regex: safe, $options: 'i' } },
            { code: { $regex: safe, $options: 'i' } },
            { description: { $regex: safe, $options: 'i' } },
        ];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Project.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        Project.countDocuments(filter),
    ]);

    // ─── Task completion rollup ─────────────────────────────────────────
    // One aggregate over the page's project IDs: group by (project_id, status)
    // so we can compute total tasks and done (terminal) tasks per project.
    // Wrapped in try/catch so a DB hiccup never 500s the list — the rollup
    // is supplemental, not load-bearing.

    /** Map of project id → { task_count, done_task_count } */
    const rollupById = new Map<string, { task_count: number; done_task_count: number }>();

    if (rows.length > 0) {
        const projectIds = rows.map((r) => r._id);

        // Build per-project terminal-status sets: default 'done' + any custom
        // status flagged is_terminal: true.
        const terminalByProject = new Map<string, Set<string>>();
        for (const r of rows) {
            const set = new Set<string>([DEFAULT_DONE_TASK_STATUS_KEY]);
            for (const s of r.custom_task_statuses ?? []) {
                if (s.is_terminal) set.add(s.key);
            }
            terminalByProject.set(r._id.toString(), set);
        }

        try {
            const perStatusBuckets = await Task.aggregate<{
                _id: { project: Types.ObjectId; status: string };
                count: number;
            }>([
                { $match: { project_id: { $in: projectIds } } },
                { $group: { _id: { project: '$project_id', status: '$status' }, count: { $sum: 1 } } },
            ]);

            // Accumulate counts per project.
            for (const b of perStatusBuckets) {
                const pid = b._id.project.toString();
                const existing = rollupById.get(pid) ?? { task_count: 0, done_task_count: 0 };
                existing.task_count += b.count;
                const terminal = terminalByProject.get(pid) ?? new Set([DEFAULT_DONE_TASK_STATUS_KEY]);
                if (terminal.has(b._id.status)) {
                    existing.done_task_count += b.count;
                }
                rollupById.set(pid, existing);
            }
        } catch (err) {
            logger.warn({ err }, 'project.listProjects: task rollup failed — defaulting to 0/0');
            // rollupById stays empty; rows get 0/0 below.
        }
    }

    const companyById = await attachCompanies(rows);

    return {
        data: rows.map((r) => {
            const counts = rollupById.get(r._id.toString()) ?? { task_count: 0, done_task_count: 0 };
            return {
                ...toPublic(r),
                company: companyOf(r, companyById),
                task_count: counts.task_count,
                done_task_count: counts.done_task_count,
            };
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /projects/:id ───────────────────────────────────────────────────

export const getProject = async (id: Types.ObjectId, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);
    // Resolved here too, so `company` isn't a field that exists on the list
    // response but vanishes on the detail one — that asymmetry is the kind
    // of thing a consumer only discovers at runtime.
    const companyById = await attachCompanies([doc]);
    return { ...toPublic(doc), company: companyOf(doc, companyById) };
};

/**
 * Exported for downstream services (tasks/comments/attachments) that need
 * to scope a query to "projects this caller can see" without re-implementing
 * the role → filter mapping. Treat the return as opaque — callers should
 * spread it into their own Mongo filter (`{...buildProjectVisibilityFilter(c), ...}`).
 */
export const buildProjectVisibilityFilter = (caller: { id: Types.ObjectId; role: RoleType }): Record<string, unknown> =>
    buildVisibilityFilter(caller);

// Helper: load + assert caller can read (used by sprint service too).
export const loadProjectForCaller = async (
    id: Types.ObjectId,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<ProjectDocument> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);
    return doc;
};

// ─── PATCH /projects/:id ─────────────────────────────────────────────────

export const updateProject = async (
    id: Types.ObjectId,
    patch: PatchProjectBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    const before = toPublic(doc);

    if (patch.name !== undefined) doc.name = patch.name;
    if (patch.description !== undefined) doc.description = patch.description;
    if (patch.start_date !== undefined) doc.start_date = patch.start_date;
    if (patch.end_date !== undefined) doc.end_date = patch.end_date;
    if (patch.status !== undefined) doc.status = patch.status as ProjectStatus;
    if (patch.is_archived !== undefined) doc.is_archived = patch.is_archived;

    // Re-assigning the company invalidates the whole client-side roster:
    // every representative_id must belong to THIS project's company, so the
    // people from the old company no longer qualify. Reset the roster and
    // re-seed it with the NEW company's clients rather than leaving rows
    // that violate the invariant — silently keeping them would hand company
    // A's people access to company B's project.
    if (patch.company_id !== undefined) {
        const nextCompanyId = patch.company_id ? new Types.ObjectId(patch.company_id) : null;
        const changed = String(doc.company_id ?? '') !== String(nextCompanyId ?? '');
        if (changed) {
            doc.company_id = nextCompanyId;
            doc.representative_ids = await companyClientIds(nextCompanyId);
        }
    }

    // Cross-field guard duplicates the validator's `.refine` for the case
    // where only one of the dates is present in the patch — the validator
    // can't know the persisted "other" date.
    if (doc.end_date !== null && doc.end_date < doc.start_date) {
        throw AppError.unprocessable("The end date can't be before the start date.", ERROR_CODES.PROJECT_DATE_INVALID);
    }

    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            before,
            after: toPublic(doc),
        });
    }

    return toPublic(doc);
};

// ─── POST /projects/:id/members  (bulk) ──────────────────────────────────
//
// F4 — atomic list mutation. Pre-F4 this loaded the doc, computed the
// new array in JS, then `doc.save()`-d. Two concurrent admin calls
// could both observe v1, each compute their own next state, and the
// loser's change was silently dropped (with a successful audit row).
//
// New shape: read once (for validation + before-snapshot), then run
// `$pull` (removes) + `$addToSet $each` (adds) as separate atomic
// updates. Both operators are idempotent + commute under concurrency,
// so two interleaved calls converge to "original − all removes + all
// adds" regardless of order. We can't combine them in a single update
// (Mongo refuses overlapping path operators), but two sequential
// atomic updates are still race-safe at the row level.
//
// Audit before/after snapshots come from the read + a re-read; under
// heavy contention the two callers' "after" snapshots may overlap
// (each captures the post-everyone state) — that's the right shape
// for an audit row anyway.

export const updateProjectMembers = async (
    id: Types.ObjectId,
    body: ProjectMembersBulkBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    const addIds = dedupeObjectIds(body.add);
    const removeIds = body.remove.map((r) => new Types.ObjectId(r));

    // Only validate the truly new IDs — re-adding someone who is already a
    // member is a no-op and we don't want a stale role change on an existing
    // member (e.g. admin → manager) to make this call fail unexpectedly.
    const existingMemberSet = new Set(doc.member_ids.map((u) => u.toString()));
    const newAddIds = addIds.filter((a) => !existingMemberSet.has(a.toString()));
    await validateMemberCandidates(newAddIds);

    const before = doc.member_ids.map((u) => u.toString());

    // F4 — two atomic updates instead of read-modify-save. Wrapped in a
    // transaction so a failure on the second write doesn't leave a project
    // with the remove applied but the add missing (member loss).
    const updated = await withTransaction(async (session) => {
        if (removeIds.length > 0) {
            await Project.updateOne({ _id: id }, { $pull: { member_ids: { $in: removeIds } } }, { session });
        }
        if (addIds.length > 0) {
            await Project.updateOne({ _id: id }, { $addToSet: { member_ids: { $each: addIds } } }, { session });
        }
        const next = await Project.findById(id, null, { session });
        if (!next) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
        return next;
    });
    const after = updated.member_ids.map((u) => u.toString());

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_MEMBERS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: updated._id },
            before: { member_ids: before },
            after: { member_ids: after },
            metadata: {
                added: addIds.map((a) => a.toString()).filter((a) => !before.includes(a)),
                removed: before.filter((b) => !after.includes(b)),
            },
        });
    }

    return toPublic(updated);
};

// ─── GET /projects/:id/members ───────────────────────────────────────────
//
// Hydrates each member ObjectId with a small public user view so the FE can
// render an avatar list without a second roundtrip.

export const listProjectMembers = async (
    id: Types.ObjectId,
    caller: ProjectCaller
): Promise<Array<{ id: string; full_name: string; email: string; role: RoleType; status: string }>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);

    if (doc.member_ids.length === 0) return [];

    const users = await User.find({ _id: { $in: doc.member_ids } })
        .select('_id full_name email role status')
        .lean<{ _id: Types.ObjectId; full_name: string; email: string; role: RoleType; status: string }[]>();

    // Preserve doc.member_ids ordering so the FE can render in the same
    // order an admin curated.
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return doc.member_ids
        .map((mid) => byId.get(String(mid)))
        .filter((u): u is { _id: Types.ObjectId; full_name: string; email: string; role: RoleType; status: string } =>
            Boolean(u)
        )
        .map((u) => ({
            id: u._id.toString(),
            full_name: u.full_name,
            email: u.email,
            role: u.role,
            status: u.status,
        }));
};

// ─── DELETE /projects/:id/members/:user_id ───────────────────────────────

export const removeProjectMember = async (
    id: Types.ObjectId,
    userId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    if (!doc.member_ids.some((u) => u.equals(userId))) {
        throw AppError.notFound('User is not a member of this project', ERROR_CODES.PROJECT_MEMBER_NOT_FOUND);
    }

    return updateProjectMembers(id, { add: [], remove: [userId.toString()] }, caller);
};

// ─── POST /projects/:id/representatives  (bulk) ──────────────────────────

export const updateProjectRepresentatives = async (
    id: Types.ObjectId,
    body: ProjectRepresentativesBulkBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    // A `client` may only staff their OWN company's projects. RBAC says
    // "may assign representatives"; it does not say "anywhere" — that scope
    // check has to live here.
    assertCallerCanRead(doc, caller);

    const addIds = dedupeObjectIds(body.add);
    const removeIds = body.remove.map((r) => new Types.ObjectId(r));

    // Same idempotency guard as members: only validate the truly new IDs.
    const existingSet = new Set(doc.representative_ids.map((u) => u.toString()));
    const newAddIds = addIds.filter((a) => !existingSet.has(a.toString()));
    await validateRepresentativeCandidates(newAddIds, doc.company_id);

    const before = doc.representative_ids.map((u) => u.toString());

    // F4 — atomic list mutation; see `updateProjectMembers` for rationale.
    const updated = await withTransaction(async (session) => {
        if (removeIds.length > 0) {
            await Project.updateOne({ _id: id }, { $pull: { representative_ids: { $in: removeIds } } }, { session });
        }
        if (addIds.length > 0) {
            await Project.updateOne({ _id: id }, { $addToSet: { representative_ids: { $each: addIds } } }, { session });
        }
        const next = await Project.findById(id, null, { session });
        if (!next) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
        return next;
    });
    const after = updated.representative_ids.map((u) => u.toString());

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_REPRESENTATIVES_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: updated._id },
            before: { representative_ids: before },
            after: { representative_ids: after },
            metadata: {
                added: addIds.map((a) => a.toString()).filter((a) => !before.includes(a)),
                removed: before.filter((b) => !after.includes(b)),
            },
        });
    }

    return toPublic(updated);
};

export const listProjectRepresentatives = async (
    id: Types.ObjectId,
    caller: ProjectCaller
): Promise<Array<{ id: string; full_name: string; email: string; status: string; role: string }>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);

    if (doc.representative_ids.length === 0) return [];

    // `company_name` is gone from this payload: the company is now the
    // project's own `company_id`, so repeating it per person was noise.
    // `role` replaces it — it's what distinguishes a company-level `client`
    // from an assigned-only `representative` on the roster.
    type RosterRow = {
        _id: Types.ObjectId;
        full_name: string;
        email: string;
        status: string;
        role: string;
    };
    const users = await User.find({ _id: { $in: doc.representative_ids } })
        .select('_id full_name email status role')
        .lean<RosterRow[]>();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return doc.representative_ids
        .map((rid) => byId.get(String(rid)))
        .filter((u): u is RosterRow => Boolean(u))
        .map((u) => ({
            id: u._id.toString(),
            full_name: u.full_name,
            email: u.email,
            status: u.status,
            role: u.role,
        }));
};

export const removeProjectRepresentative = async (
    id: Types.ObjectId,
    userId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    if (!doc.representative_ids.some((u) => u.equals(userId))) {
        throw AppError.notFound('User is not a representative of this project', ERROR_CODES.PROJECT_CLIENT_NOT_FOUND);
    }
    return updateProjectRepresentatives(id, { add: [], remove: [userId.toString()] }, caller);
};

// ─── Custom-task-statuses ────────────────────────────────────────────────

const findCustomStatusOrThrow = (doc: ProjectDocument, statusId: Types.ObjectId): CustomTaskStatus => {
    const sub = doc.custom_task_statuses.id(statusId) as CustomTaskStatus | null;
    if (!sub) {
        throw AppError.notFound('Custom status not found on this project', ERROR_CODES.CUSTOM_STATUS_NOT_FOUND);
    }
    return sub;
};

export const listCustomStatuses = async (
    id: Types.ObjectId,
    caller: ProjectCaller
): Promise<{
    defaults: { key: string; order: number; is_active: boolean }[];
    custom: Array<
        Pick<CustomTaskStatus, 'key' | 'label' | 'order' | 'is_terminal' | 'is_active'> & {
            id: string;
        }
    >;
}> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);

    // Defaults are returned with their project-scoped `order` + `is_active`
    // values so the FE can merge defaults + customs into a single sorted
    // column list and filter hidden columns out. Fall-back values keep
    // the API safe during the migration window for pre-existing projects.
    const orderByKey = new Map<string, number>();
    const activeByKey = new Map<string, boolean>();
    for (const o of doc.default_status_orders ?? []) {
        orderByKey.set(o.key, o.order);
        activeByKey.set(o.key, o.is_active);
    }
    const defaults = DEFAULT_TASK_STATUS_KEYS.map((k, i) => ({
        key: k,
        order: orderByKey.get(k) ?? (i + 1) * 100,
        is_active: activeByKey.get(k) ?? true,
    })).sort((a, b) => a.order - b.order);

    return {
        defaults,
        custom: doc.custom_task_statuses
            .map((s) => ({
                id: s._id.toString(),
                key: s.key,
                label: s.label,
                order: s.order,
                is_terminal: s.is_terminal,
                is_active: s.is_active,
            }))
            .sort((a, b) => a.order - b.order),
    };
};

export const addCustomStatus = async (
    id: Types.ObjectId,
    body: CreateCustomStatusBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    // Key is auto-derived from the label when the caller omits it (the common
    // path — the create dialog no longer asks for one). The slug is deduped
    // against the built-ins and this project's existing custom keys, so an
    // auto key never collides; an explicitly-supplied key still can.
    const key =
        body.key ??
        pickCustomStatusKey(slugifyCustomStatusKey(body.label), new Set(doc.custom_task_statuses.map((s) => s.key)));

    if (doc.custom_task_statuses.some((s) => s.key === key)) {
        throw AppError.conflict('A custom status with this key already exists', ERROR_CODES.CUSTOM_STATUS_KEY_TAKEN, {
            key,
        });
    }

    const sub = doc.custom_task_statuses.create({
        key,
        label: body.label,
        order: body.order,
        is_terminal: body.is_terminal,
        is_active: body.is_active,
    });
    doc.custom_task_statuses.push(sub);
    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_CUSTOM_STATUS_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            after: {
                custom_status: {
                    id: sub._id.toString(),
                    key,
                    label: body.label,
                    order: body.order,
                    is_terminal: body.is_terminal,
                    is_active: body.is_active,
                },
            },
        });
    }

    return {
        id: sub._id.toString(),
        key: sub.key,
        label: sub.label,
        order: sub.order,
        is_terminal: sub.is_terminal,
        is_active: sub.is_active,
    };
};

/**
 * Replace the project's `default_status_orders` array atomically. Body
 * validator already guarantees:
 *   - exactly four entries
 *   - each canonical key appears exactly once
 *   - `order` is a non-negative integer
 *
 * So this just maps body → schema shape and writes. Returns the updated
 * `defaults` array in the same shape `listCustomStatuses` uses, so the FE
 * can swap it into its cache without an extra GET.
 */
export const patchDefaultStatusOrders = async (
    id: Types.ObjectId,
    body: { orders: Array<{ key: string; order: number; is_active?: boolean }> },
    caller: ProjectCaller
): Promise<{
    defaults: { key: string; order: number; is_active: boolean }[];
}> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);

    // Snapshot current is_active per key so we can preserve values for
    // entries where the caller omitted the flag (validator marks it
    // optional). Then atomically replace the array.
    const activeByKey = new Map<string, boolean>();
    for (const o of doc.default_status_orders) {
        activeByKey.set(o.key, o.is_active);
    }
    const before = doc.default_status_orders.map((o) => ({
        key: o.key,
        order: o.order,
        is_active: o.is_active,
    }));

    doc.default_status_orders.splice(0);
    for (const entry of body.orders) {
        doc.default_status_orders.push({
            key: entry.key,
            order: entry.order,
            is_active: entry.is_active ?? activeByKey.get(entry.key) ?? true,
        });
    }
    await doc.save();

    const after = doc.default_status_orders.map((o) => ({
        key: o.key,
        order: o.order,
        is_active: o.is_active,
    }));

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_DEFAULT_STATUS_ORDERS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            before: { default_status_orders: before },
            after: { default_status_orders: after },
        });
    }

    const defaults = after.slice().sort((a, b) => a.order - b.order);
    return { defaults };
};

// Top-level lookup: `PATCH /project-custom-statuses/:id` — find owning project
// by sub-doc id. Returns the project + sub-doc to the caller.
const findProjectByCustomStatusId = async (statusId: Types.ObjectId): Promise<ProjectDocument> => {
    const doc = await Project.findOne({ 'custom_task_statuses._id': statusId });
    if (!doc) throw AppError.notFound('Custom status not found', ERROR_CODES.CUSTOM_STATUS_NOT_FOUND);
    return doc;
};

export const patchCustomStatus = async (
    statusId: Types.ObjectId,
    patch: PatchCustomStatusBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await findProjectByCustomStatusId(statusId);
    const sub = findCustomStatusOrThrow(doc, statusId);

    const before = {
        id: sub._id.toString(),
        key: sub.key,
        label: sub.label,
        order: sub.order,
        is_terminal: sub.is_terminal,
        is_active: sub.is_active,
    };

    if (patch.label !== undefined) sub.label = patch.label;
    if (patch.order !== undefined) sub.order = patch.order;
    if (patch.is_terminal !== undefined) sub.is_terminal = patch.is_terminal;
    if (patch.is_active !== undefined) sub.is_active = patch.is_active;

    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_CUSTOM_STATUS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            before: { custom_status: before },
            after: {
                custom_status: {
                    id: sub._id.toString(),
                    key: sub.key,
                    label: sub.label,
                    order: sub.order,
                    is_terminal: sub.is_terminal,
                    is_active: sub.is_active,
                },
            },
        });
    }

    return {
        id: sub._id.toString(),
        key: sub.key,
        label: sub.label,
        order: sub.order,
        is_terminal: sub.is_terminal,
        is_active: sub.is_active,
    };
};

export const deleteCustomStatus = async (statusId: Types.ObjectId, caller: ProjectCaller): Promise<void> => {
    const doc = await findProjectByCustomStatusId(statusId);
    const sub = findCustomStatusOrThrow(doc, statusId);

    const snapshot = {
        id: sub._id.toString(),
        key: sub.key,
        label: sub.label,
        order: sub.order,
        is_terminal: sub.is_terminal,
    };

    // R3 — refuse to delete a status that any task in this project
    // is currently using. The admin's recourse is to PATCH each affected
    // task onto a different status first, then re-issue the delete.
    const dependentTasks = await Task.countDocuments({ project_id: doc._id, status: sub.key });
    if (dependentTasks > 0) {
        throw AppError.conflict(
            'Custom status is in use; reassign the tasks to another status before deleting it.',
            ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            { tasks: dependentTasks, status_key: sub.key }
        );
    }

    doc.custom_task_statuses.pull({ _id: sub._id });
    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_CUSTOM_STATUS_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            before: { custom_status: snapshot },
        });
    }
};

// ─── DELETE /projects/:id  (hard delete with dependant guard) ────────────
//
// Refuse the delete if any tasks/stories/sprints reference this project
// (BACKEND_AUDIT.md R3). Admin must archive (`is_archived = true`) or
// reassign the dependants first; the archive UI is the intended path
// for "decommission a project that already has work logged against it".
//
// The three counts run in parallel. We don't bother batching by
// `Promise.all` here — the limit query is fast and the no-deps case is
// the dominant path; an extra ~5ms on the rejection path is fine.

export const deleteProject = async (id: Types.ObjectId, caller: ProjectCaller): Promise<void> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    const [taskCount, storyCount, sprintCount] = await Promise.all([
        Task.countDocuments({ project_id: id }),
        Story.countDocuments({ project_id: id }),
        Sprint.countDocuments({ project_id: id }),
    ]);
    if (taskCount > 0 || storyCount > 0 || sprintCount > 0) {
        throw AppError.conflict(
            'Project has dependants; archive it (or reassign the items) before deleting.',
            ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            { tasks: taskCount, stories: storyCount, sprints: sprintCount }
        );
    }

    const before = toPublic(doc);

    await doc.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_ARCHIVE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: doc._id },
            before,
            metadata: { hard_delete: true },
        });
    }
};
