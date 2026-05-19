import { Types } from 'mongoose';

import { Project, type ProjectDocument, type CustomTaskStatus } from '../models/project.model.js';
import { Sprint } from '../models/sprint.model.js';
import { Story } from '../models/story.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
    DEFAULT_TASK_STATUS_KEYS,
    PROJECT_CLIENT_SCOPED_ROLES,
    PROJECT_MEMBER_SCOPED_ROLES,
    type ProjectStatus,
} from '../constants/project.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateCustomStatusBody,
    CreateProjectBody,
    ListProjectsQuery,
    PatchCustomStatusBody,
    PatchProjectBody,
    ProjectClientsBulkBody,
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
 *    see projects where `member_ids ∋ caller.id`; clients see projects where
 *    `client_ids ∋ caller.id`. The single `buildVisibilityFilter` helper is
 *    the one place this rule lives — every read that must respect visibility
 *    composes it into its filter.
 *
 * Member/client semantics:
 *  - `add` and `remove` are computed against the existing array so the bulk
 *    endpoint is idempotent: re-running the same payload converges on the
 *    same end-state. We dedupe + ignore unknown removes so the FE can fire
 *    "remove these 5 IDs" without having to inspect the current array first.
 *  - `add` candidates are validated against the `users` collection: members
 *    must be active internal users (admin/manager/employee), clients must be
 *    active client-role users. Mismatches throw 422 INVALID_PROJECT_*_ROLE
 *    so the admin sees exactly which IDs are wrong.
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
    audit?: AuditContext;
}

// ─── Visibility scoping ──────────────────────────────────────────────────

/**
 * Step 47: Manager + Admin see every project; **Team Lead** + Employee
 * see only projects where they appear in `member_ids`. Team Leads are
 * project authors within projects they belong to (the legacy
 * project-member scoping is the same — the difference is purely
 * authoring permissions, which the route layer gates separately).
 */
const buildVisibilityFilter = (caller: { id: Types.ObjectId; role: RoleType }): Record<string, unknown> => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER) return {};
    if (PROJECT_MEMBER_SCOPED_ROLES.includes(caller.role)) return { member_ids: caller.id };
    if (PROJECT_CLIENT_SCOPED_ROLES.includes(caller.role)) return { client_ids: caller.id };
    // Defence in depth — any future role we forget to map gets no visibility
    // rather than implicit access to everything.
    return { _id: new Types.ObjectId('000000000000000000000000') };
};

const assertCallerCanRead = (project: ProjectDocument, caller: { id: Types.ObjectId; role: RoleType }): void => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER) return;
    const has = (arr: Types.ObjectId[]): boolean => arr.some((u) => u.equals(caller.id));
    if (PROJECT_MEMBER_SCOPED_ROLES.includes(caller.role) && has(project.member_ids)) return;
    if (PROJECT_CLIENT_SCOPED_ROLES.includes(caller.role) && has(project.client_ids)) return;
    throw AppError.forbidden('You do not have access to this project', ERROR_CODES.FORBIDDEN);
};

// ─── Serialisation ───────────────────────────────────────────────────────

const toPublic = (doc: ProjectDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

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
            'One or more user_ids are not active internal users',
            ERROR_CODES.INVALID_PROJECT_MEMBER_ROLE,
            { invalid_user_ids: bad }
        );
    }
};

const validateClientCandidates = async (ids: Types.ObjectId[]): Promise<void> => {
    if (ids.length === 0) return;
    const found = await User.find({ _id: { $in: ids }, status: USER_STATUSES.ACTIVE, role: ROLES.CLIENT })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>();
    const okIds = new Set<string>(found.map((u) => String(u._id)));
    const bad = ids.filter((id) => !okIds.has(String(id))).map((id) => id.toString());
    if (bad.length > 0) {
        throw AppError.unprocessable(
            'One or more user_ids are not active client users',
            ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            { invalid_user_ids: bad }
        );
    }
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

// ─── POST /projects ──────────────────────────────────────────────────────

export const createProject = async (
    input: CreateProjectBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const memberIds = dedupeObjectIds(input.member_ids);
    const clientIds = dedupeObjectIds(input.client_ids);

    await validateMemberCandidates(memberIds);
    await validateClientCandidates(clientIds);

    let created: ProjectDocument;
    try {
        created = await Project.create({
            name: input.name,
            code: input.code,
            description: input.description,
            start_date: input.start_date,
            end_date: input.end_date,
            status: input.status,
            member_ids: memberIds,
            client_ids: clientIds,
            custom_task_statuses: input.custom_task_statuses,
            created_by: caller.id,
        });
    } catch (err) {
        if (isCodeDuplicateError(err)) {
            throw AppError.conflict('A project with this code already exists', ERROR_CODES.PROJECT_CODE_TAKEN, {
                code: input.code,
            });
        }
        throw err;
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
    if (query.client_id) filter.client_ids = new Types.ObjectId(query.client_id);

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

    return {
        data: rows.map(toPublic),
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
    return toPublic(doc);
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

    // Cross-field guard duplicates the validator's `.refine` for the case
    // where only one of the dates is present in the patch — the validator
    // can't know the persisted "other" date.
    if (doc.end_date !== null && doc.end_date < doc.start_date) {
        throw AppError.unprocessable('end_date must be on or after start_date', ERROR_CODES.PROJECT_DATE_INVALID);
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
            await Project.updateOne(
                { _id: id },
                { $pull: { member_ids: { $in: removeIds } } },
                { session }
            );
        }
        if (addIds.length > 0) {
            await Project.updateOne(
                { _id: id },
                { $addToSet: { member_ids: { $each: addIds } } },
                { session }
            );
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

// ─── POST /projects/:id/clients  (bulk) ──────────────────────────────────

export const updateProjectClients = async (
    id: Types.ObjectId,
    body: ProjectClientsBulkBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);

    const addIds = dedupeObjectIds(body.add);
    const removeIds = body.remove.map((r) => new Types.ObjectId(r));

    // Same idempotency guard as members: only validate the truly new IDs.
    const existingClientSet = new Set(doc.client_ids.map((u) => u.toString()));
    const newAddIds = addIds.filter((a) => !existingClientSet.has(a.toString()));
    await validateClientCandidates(newAddIds);

    const before = doc.client_ids.map((u) => u.toString());

    // F4 — atomic list mutation; see `updateProjectMembers` for rationale.
    const updated = await withTransaction(async (session) => {
        if (removeIds.length > 0) {
            await Project.updateOne(
                { _id: id },
                { $pull: { client_ids: { $in: removeIds } } },
                { session }
            );
        }
        if (addIds.length > 0) {
            await Project.updateOne(
                { _id: id },
                { $addToSet: { client_ids: { $each: addIds } } },
                { session }
            );
        }
        const next = await Project.findById(id, null, { session });
        if (!next) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
        return next;
    });
    const after = updated.client_ids.map((u) => u.toString());

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PROJECT_CLIENTS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.PROJECT, id: updated._id },
            before: { client_ids: before },
            after: { client_ids: after },
            metadata: {
                added: addIds.map((a) => a.toString()).filter((a) => !before.includes(a)),
                removed: before.filter((b) => !after.includes(b)),
            },
        });
    }

    return toPublic(updated);
};

export const listProjectClients = async (
    id: Types.ObjectId,
    caller: ProjectCaller
): Promise<Array<{ id: string; full_name: string; email: string; status: string; company_name: string | null }>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    assertCallerCanRead(doc, caller);

    if (doc.client_ids.length === 0) return [];

    const users = await User.find({ _id: { $in: doc.client_ids } })
        .select('_id full_name email status client_profile')
        .lean<
            {
                _id: Types.ObjectId;
                full_name: string;
                email: string;
                status: string;
                client_profile?: { company_name?: string };
            }[]
        >();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return doc.client_ids
        .map((cid) => byId.get(String(cid)))
        .filter(
            (
                u
            ): u is {
                _id: Types.ObjectId;
                full_name: string;
                email: string;
                status: string;
                client_profile?: { company_name?: string };
            } => Boolean(u)
        )
        .map((u) => ({
            id: u._id.toString(),
            full_name: u.full_name,
            email: u.email,
            status: u.status,
            company_name: u.client_profile?.company_name ?? null,
        }));
};

export const removeProjectClient = async (
    id: Types.ObjectId,
    userId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const doc = await Project.findById(id);
    if (!doc) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    if (!doc.client_ids.some((u) => u.equals(userId))) {
        throw AppError.notFound('User is not a client of this project', ERROR_CODES.PROJECT_CLIENT_NOT_FOUND);
    }
    return updateProjectClients(id, { add: [], remove: [userId.toString()] }, caller);
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

    if (doc.custom_task_statuses.some((s) => s.key === body.key)) {
        throw AppError.conflict('A custom status with this key already exists', ERROR_CODES.CUSTOM_STATUS_KEY_TAKEN, {
            key: body.key,
        });
    }

    const sub = doc.custom_task_statuses.create({
        key: body.key,
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
            after: { custom_status: { id: sub._id.toString(), ...body } },
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
