import { Types } from 'mongoose';

import { BillingRate, type BillingRateDocument } from '../models/billing-rate.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateBillingRateBody,
    ListBillingRatesQuery,
    PatchBillingRateBody,
} from '../validators/billing-rate.validator.js';

/**
 * Billing-rate service — Data_Model.md §6.2 / API_Contract.md §9.5 /
 * BUILD_PROGRESS.md Step 23.
 *
 * Write-side invariants enforced here (the model is pure storage):
 *
 *   1. `effective_to >= effective_from` — both inclusive ISO date strings.
 *      Lexical comparison is date-correct for `YYYY-MM-DD`.
 *
 *   2. **Auto-close overlap on create.** When admin creates a new rate
 *      for `(user, project, task)` whose `effective_from` falls inside
 *      a still-open existing range, the predecessor's `effective_to`
 *      is set to the day before the new `effective_from`. Two open
 *      ranges for the same tuple are never simultaneously valid — the
 *      lookup at report time relies on this monotonicity.
 *
 *   3. **Delete only if unused.** Deleting a rate that's already been
 *      referenced by any timesheet entry would silently invalidate
 *      historical bills. We block it with `BILLING_RATE_IN_USE`. The
 *      "usage" is conservatively defined as "any timesheet entry on
 *      the same `(user, project, task)` tuple within the rate's
 *      effective range" — even non-billable rows count, because the
 *      report engine still pulls them through the same join.
 *
 * Audit: every mutation records a row. `billing_rate.create` carries
 * `metadata.previous_rate_id` when the create auto-closed a predecessor,
 * so the Step-31 audit UI can render a "rate history" timeline.
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface BillingRateCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const toPublic = (doc: BillingRateDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const yesterdayOf = (isoDate: string): string => dayjs(isoDate).subtract(1, 'day').format(DATE_FORMAT);
const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const assertRange = (effectiveFrom: string, effectiveTo: string | null): void => {
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
        throw AppError.unprocessable(
            'effective_to must be on or after effective_from',
            ERROR_CODES.BILLING_RATE_INVALID_RANGE,
            { effective_from: effectiveFrom, effective_to: effectiveTo }
        );
    }
};

/**
 * Verify the user / project / task references all exist. We don't load
 * them into memory beyond the existence check — the rate row stores
 * ObjectIds for the report engine to dereference at query time.
 */
const assertReferencesExist = async (input: {
    user_id: Types.ObjectId;
    project_id: Types.ObjectId;
    task_id: Types.ObjectId | null;
}): Promise<void> => {
    const [userExists, projectExists] = await Promise.all([
        User.exists({ _id: input.user_id }),
        Project.exists({ _id: input.project_id }),
    ]);
    if (!userExists) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    if (!projectExists) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    if (input.task_id) {
        const taskExists = await Task.exists({ _id: input.task_id, project_id: input.project_id });
        if (!taskExists) {
            throw AppError.notFound('Task not found in this project', ERROR_CODES.TASK_NOT_FOUND);
        }
    }
};

const loadOr404 = async (id: Types.ObjectId): Promise<BillingRateDocument> => {
    const rate = await BillingRate.findById(id);
    if (!rate) throw AppError.notFound('Billing rate not found', ERROR_CODES.BILLING_RATE_NOT_FOUND);
    return rate;
};

/**
 * Find every existing rate row whose effective range overlaps with the
 * proposed new range for the same `(user, project, task)` tuple.
 *
 * Symmetric overlap predicate: two ranges `[a1, a2]` and `[b1, b2]`
 * overlap iff `a1 <= b2` AND `a2 >= b1` (treating null as +infinity).
 * `findOne` was wrong here — it only caught predecessors whose
 * `effective_from` was before the new one, which silently allowed a
 * back-fill (B `2025-06-01 → 2026-03-31` inserted while A
 * `2026-01-01 → null` exists) to create two simultaneously-applicable
 * rows. We now find ALL overlaps and let the caller decide whether to
 * auto-close (the simple "extend the current rate" case) or refuse.
 */
const findOverlappingRates = async (input: {
    user_id: Types.ObjectId;
    project_id: Types.ObjectId;
    task_id: Types.ObjectId | null;
    effective_from: string;
    effective_to: string | null;
}): Promise<BillingRateDocument[]> => {
    const newFrom = input.effective_from;
    const newTo = input.effective_to; // null = +infinity
    // existing.from <= newTo  (treating newTo === null as "always true")
    const startFilter = newTo !== null ? { $lte: newTo } : undefined;
    // existing.to == null OR existing.to >= newFrom
    const endOr: Record<string, unknown>[] = [{ effective_to: null }, { effective_to: { $gte: newFrom } }];

    const filter: Record<string, unknown> = {
        user_id: input.user_id,
        project_id: input.project_id,
        task_id: input.task_id,
        $or: endOr,
    };
    if (startFilter) filter.effective_from = startFilter;
    return BillingRate.find(filter);
};

// ─── POST /billing-rates ─────────────────────────────────────────────────

export const createRate = async (
    input: CreateBillingRateBody,
    caller: BillingRateCaller
): Promise<Record<string, unknown>> => {
    const userOid = new Types.ObjectId(input.user_id);
    const projectOid = new Types.ObjectId(input.project_id);
    const taskOid = input.task_id ? new Types.ObjectId(input.task_id) : null;

    assertRange(input.effective_from, input.effective_to ?? null);
    await assertReferencesExist({ user_id: userOid, project_id: projectOid, task_id: taskOid });

    // Overlap handling. Two cases the spec wants to support:
    //
    //   (a) Forward extension — admin adds a NEW open-ended rate that
    //       supersedes the current one. Exactly one existing row,
    //       open-ended, starts strictly before the new effective_from.
    //       Auto-close the predecessor to `effective_from - 1` and
    //       insert the new rate.
    //
    //   (b) Anything else (back-fill, multi-overlap, same-day overlap,
    //       overlap with a closed range that would leave the timeline
    //       ambiguous on any day) → refuse with `BILLING_RATE_INVALID_RANGE`.
    //       Admin must use `/end` first or pick a non-overlapping
    //       window. The audit UI's lookup at report time relies on at
    //       most one rate being effective on any given day, so we hold
    //       the line here rather than try to be clever.
    let previousRateId: Types.ObjectId | null = null;
    const overlaps = await findOverlappingRates({
        user_id: userOid,
        project_id: projectOid,
        task_id: taskOid,
        effective_from: input.effective_from,
        effective_to: input.effective_to ?? null,
    });
    if (overlaps.length > 0) {
        const onlyOne = overlaps.length === 1 ? overlaps[0] : null;
        const isSimpleForwardExtend =
            onlyOne !== null &&
            onlyOne.effective_to === null &&
            onlyOne.effective_from < input.effective_from &&
            input.effective_to === null;
        if (!isSimpleForwardExtend) {
            throw AppError.unprocessable(
                'New rate would overlap an existing rate for this tuple — end or remove the conflicting rate first',
                ERROR_CODES.BILLING_RATE_INVALID_RANGE,
                {
                    overlapping_rate_ids: overlaps.map((o) => o._id.toString()),
                }
            );
        }
        const closingDate = yesterdayOf(input.effective_from);
        // (Defensive — `isSimpleForwardExtend` already guarantees this,
        // but the order-of-operations check keeps the assertion local.)
        if (closingDate < onlyOne.effective_from) {
            throw AppError.unprocessable(
                'New rate must start AFTER the existing rate for this tuple — end the predecessor first',
                ERROR_CODES.BILLING_RATE_INVALID_RANGE,
                { existing_rate_id: onlyOne._id.toString(), existing_effective_from: onlyOne.effective_from }
            );
        }
        onlyOne.effective_to = closingDate;
        await onlyOne.save();
        previousRateId = onlyOne._id;
    }

    let created: BillingRateDocument;
    try {
        created = await BillingRate.create({
            user_id: userOid,
            project_id: projectOid,
            task_id: taskOid,
            hourly_rate: input.hourly_rate,
            effective_from: input.effective_from,
            effective_to: input.effective_to ?? null,
            created_by: caller.id,
        });
    } catch (err: unknown) {
        // The `(user, project, task, effective_from)` unique index turns
        // a parallel-insert race (two admins posting the same row) into
        // a deterministic 409 instead of a silent double-row.
        const e = err as { code?: number; keyPattern?: Record<string, unknown> };
        if (e?.code === 11000) {
            throw AppError.conflict(
                'A billing rate with this (user, project, task, effective_from) already exists',
                ERROR_CODES.DUPLICATE_RESOURCE,
                {
                    user_id: userOid.toString(),
                    project_id: projectOid.toString(),
                    task_id: taskOid?.toString() ?? null,
                    effective_from: input.effective_from,
                }
            );
        }
        throw err;
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.BILLING_RATE_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.BILLING_RATE, id: created._id },
            after: toPublic(created),
            metadata: {
                user_id: userOid.toString(),
                project_id: projectOid.toString(),
                task_id: taskOid?.toString() ?? null,
                previous_rate_id: previousRateId?.toString() ?? null,
            },
        });
    }

    return toPublic(created);
};

// ─── PATCH /billing-rates/:id ────────────────────────────────────────────

export const patchRate = async (
    id: Types.ObjectId,
    patch: PatchBillingRateBody,
    caller: BillingRateCaller
): Promise<Record<string, unknown>> => {
    const rate = await loadOr404(id);
    const before = toPublic(rate);

    if (patch.hourly_rate !== undefined) rate.hourly_rate = patch.hourly_rate;
    if (patch.effective_to !== undefined) rate.effective_to = patch.effective_to;

    assertRange(rate.effective_from, rate.effective_to);

    await rate.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.BILLING_RATE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.BILLING_RATE, id: rate._id },
            before,
            after: toPublic(rate),
        });
    }

    return toPublic(rate);
};

// ─── POST /billing-rates/:id/end ─────────────────────────────────────────

export const endRate = async (id: Types.ObjectId, caller: BillingRateCaller): Promise<Record<string, unknown>> => {
    const rate = await loadOr404(id);

    // Idempotent — `/end` on an already-ended rate is a no-op success
    // rather than a silent re-extension. An admin re-clicking the end
    // button shouldn't move the boundary forward to today and accidentally
    // re-bill the intervening days at this rate when the report engine
    // runs. Returning the row unchanged is the safe default; if an admin
    // genuinely wants to move the boundary, PATCH `effective_to` is the
    // explicit lever.
    if (rate.effective_to !== null) {
        return toPublic(rate);
    }

    const before = toPublic(rate);

    const today = todayLocal();
    // Don't move `effective_to` backwards into impossible territory if
    // the rate started in the future (admin created a forward-dated row
    // and is now ending it before it began). Set to `effective_from` in
    // that case so the row is a valid empty range — semantically "never
    // applied" without deleting the audit pointer.
    rate.effective_to = today < rate.effective_from ? rate.effective_from : today;
    await rate.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.BILLING_RATE_END,
            target: { kind: AUDIT_TARGET_KINDS.BILLING_RATE, id: rate._id },
            before,
            after: toPublic(rate),
        });
    }

    return toPublic(rate);
};

// ─── DELETE /billing-rates/:id ───────────────────────────────────────────
//
// "Only if never used" — `BILLING_RATE_IN_USE` (409) when any timesheet
// entry on the same (user, project, task) tuple falls inside the
// effective range. The conservative usage definition prevents historical
// billing reports from silently rebasing onto the next-most-recent rate.

export const deleteRate = async (id: Types.ObjectId, caller: BillingRateCaller): Promise<{ deleted: true }> => {
    const rate = await loadOr404(id);

    const usageFilter: Record<string, unknown> = {
        user_id: rate.user_id,
        project_id: rate.project_id,
        local_date: { $gte: rate.effective_from },
    };
    if (rate.task_id) usageFilter.task_id = rate.task_id;
    if (rate.effective_to !== null) {
        (usageFilter.local_date as Record<string, unknown>).$lte = rate.effective_to;
    }
    const used = await TimesheetEntry.exists(usageFilter);
    if (used) {
        throw AppError.conflict(
            'Cannot delete a billing rate that has already been applied to timesheet entries',
            ERROR_CODES.BILLING_RATE_IN_USE
        );
    }

    const before = toPublic(rate);
    await rate.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.BILLING_RATE_DELETE,
            // A billing rate has no name — label it with its amount + start date.
            target: {
                kind: AUDIT_TARGET_KINDS.BILLING_RATE,
                id: rate._id,
                label: `${rate.hourly_rate}/hr from ${rate.effective_from}`,
            },
            before,
        });
    }

    return { deleted: true };
};

// ─── GET /billing-rates ──────────────────────────────────────────────────

/**
 * Per-page display hydration — mirrors the audit/attendance/leaves/
 * timesheet pattern so the admin billing-rate UI can render names
 * without N+1 lookups.
 */
interface BillingRateUserDisplay {
    id: string;
    full_name: string | null;
}
interface BillingRateProjectDisplay {
    id: string;
    name: string;
    code: string;
}
interface BillingRateTaskDisplay {
    id: string;
    title: string | null;
}

const loadBillingRateUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, BillingRateUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(users.map((u) => [u._id.toString(), { id: u._id.toString(), full_name: u.full_name }]));
};

const loadBillingRateProjectDisplays = async (
    ids: Types.ObjectId[]
): Promise<Map<string, BillingRateProjectDisplay>> => {
    if (ids.length === 0) return new Map();
    const projects = await Project.find({ _id: { $in: ids } })
        .select('_id name code')
        .lean<{ _id: Types.ObjectId; name: string; code: string }[]>();
    return new Map(projects.map((p) => [p._id.toString(), { id: p._id.toString(), name: p.name, code: p.code }]));
};

const loadBillingRateTaskDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, BillingRateTaskDisplay>> => {
    if (ids.length === 0) return new Map();
    const tasks = await Task.find({ _id: { $in: ids } })
        .select('_id title')
        .lean<{ _id: Types.ObjectId; title: string }[]>();
    return new Map(tasks.map((t) => [t._id.toString(), { id: t._id.toString(), title: t.title }]));
};

export const listRates = async (
    query: ListBillingRatesQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    if (query.project_id) filter.project_id = new Types.ObjectId(query.project_id);
    if (query.task_id) filter.task_id = new Types.ObjectId(query.task_id);
    if (query.active_on) {
        filter.effective_from = { $lte: query.active_on };
        filter.$or = [{ effective_to: null }, { effective_to: { $gte: query.active_on } }];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        BillingRate.find(filter).sort({ effective_from: -1, _id: -1 }).skip(skip).limit(query.limit),
        BillingRate.countDocuments(filter),
    ]);

    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const projectIds = Array.from(new Set(rows.map((r) => r.project_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const taskIds = Array.from(new Set(rows.filter((r) => r.task_id).map((r) => r.task_id!.toString()))).map(
        (id) => new Types.ObjectId(id)
    );

    const [userMap, projectMap, taskMap] = await Promise.all([
        loadBillingRateUserDisplays(userIds),
        loadBillingRateProjectDisplays(projectIds),
        loadBillingRateTaskDisplays(taskIds),
    ]);

    return {
        data: rows.map((r) => {
            const obj = toPublic(r);
            obj.user = userMap.get(r.user_id.toString()) ?? {
                id: r.user_id.toString(),
                full_name: null,
            };
            obj.project = projectMap.get(r.project_id.toString()) ?? {
                id: r.project_id.toString(),
                name: null,
                code: null,
            };
            if (r.task_id) {
                obj.task = taskMap.get(r.task_id.toString()) ?? {
                    id: r.task_id.toString(),
                    title: null,
                };
            }
            return obj;
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};
