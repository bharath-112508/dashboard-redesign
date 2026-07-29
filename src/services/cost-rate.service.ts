import { Types, type ClientSession } from 'mongoose';

import { CostRate, type CostRateDocument } from '../models/cost-rate.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { withTransaction } from '../utils/with-transaction.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateCostRateInput,
    ListCostRatesQuery,
    UpdateCostRateInput,
} from '../validators/cost-rate.validator.js';

/**
 * Cost-rate service — Billing Phase 2 "Cost Rates & Margin" (Task 3).
 *
 * The cost-side twin of `billing-rate.service.ts`. Same write-side
 * invariants, minus the project/task dimension — a cost rate is
 * per-`user_id` only:
 *
 *   1. `effective_to >= effective_from` — both inclusive ISO date strings.
 *      Lexical comparison is date-correct for `YYYY-MM-DD`.
 *
 *   2. **Forward-extension auto-close.** When an admin creates a new rate
 *      for `user_id` whose `effective_from` falls after a still-open
 *      existing range, the predecessor's `effective_to` is set to the day
 *      before the new `effective_from`. Two open ranges for the same user
 *      are never simultaneously valid — `resolveCostRateForUser` relies on
 *      this monotonicity.
 *
 *   3. **Delete only if unused.** Deleting a rate that's already been
 *      applied to a timesheet entry would silently invalidate historical
 *      margin figures. Blocked with `COST_RATE_IN_USE`, guarded on
 *      `user_id` + `local_date` window overlap (no project/task dimension
 *      to narrow by, unlike billing-rate).
 *
 * `resolveCostRateForUser(userId, onDate)` is the rate-at-date lookup the
 * Task 4 margin service consumes.
 *
 * Audit: every mutation records a row. `cost_rate.create` carries
 * `metadata.previous_rate_id` when the create auto-closed a predecessor.
 *
 * `createCostRate`'s auto-close + insert is a multi-write, run inside
 * `withTransaction` so a crash between closing the predecessor and
 * inserting the new row can't leave the timeline with a gap or a
 * still-open predecessor alongside the new rate.
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface CostRateCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const toPublic = (doc: CostRateDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const yesterdayOf = (isoDate: string): string => dayjs(isoDate).subtract(1, 'day').format(DATE_FORMAT);
const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const assertRange = (effectiveFrom: string, effectiveTo: string | null): void => {
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
        throw AppError.unprocessable(
            'effective_to must be on or after effective_from',
            ERROR_CODES.COST_RATE_INVALID_RANGE,
            { effective_from: effectiveFrom, effective_to: effectiveTo }
        );
    }
};

const assertUserExists = async (userId: Types.ObjectId): Promise<void> => {
    const userExists = await User.exists({ _id: userId });
    if (!userExists) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
};

const loadOr404 = async (id: Types.ObjectId): Promise<CostRateDocument> => {
    const rate = await CostRate.findById(id);
    if (!rate) throw AppError.notFound('Cost rate not found', ERROR_CODES.COST_RATE_NOT_FOUND);
    return rate;
};

/**
 * Find every existing rate row whose effective range overlaps with the
 * proposed new range for the same `user_id`. Symmetric overlap predicate —
 * see `billing-rate.service.ts`'s `findOverlappingRates` for the full
 * rationale (a `findOne` here would miss back-fill overlaps against an
 * open-ended row).
 */
const findOverlappingRates = async (
    input: { user_id: Types.ObjectId; effective_from: string; effective_to: string | null },
    session: ClientSession | undefined
): Promise<CostRateDocument[]> => {
    const newFrom = input.effective_from;
    const newTo = input.effective_to; // null = +infinity
    const startFilter = newTo !== null ? { $lte: newTo } : undefined;
    const endOr: Record<string, unknown>[] = [{ effective_to: null }, { effective_to: { $gte: newFrom } }];

    const filter: Record<string, unknown> = {
        user_id: input.user_id,
        $or: endOr,
    };
    if (startFilter) filter.effective_from = startFilter;

    const query = CostRate.find(filter);
    return session ? query.session(session) : query;
};

// ─── POST /cost-rates ────────────────────────────────────────────────────

export const createCostRate = async (
    input: CreateCostRateInput,
    caller: CostRateCaller
): Promise<Record<string, unknown>> => {
    const userOid = new Types.ObjectId(input.user_id);

    assertRange(input.effective_from, input.effective_to ?? null);
    await assertUserExists(userOid);

    return withTransaction(async (session: ClientSession | undefined) => {
        // Overlap handling — same two cases as billing-rate:
        //   (a) Forward extension — exactly one existing open-ended row that
        //       starts strictly before the new effective_from. Auto-close
        //       the predecessor to `effective_from - 1` and insert.
        //   (b) Anything else → refuse with `COST_RATE_INVALID_RANGE`.
        let previousRateId: Types.ObjectId | null = null;
        const overlaps = await findOverlappingRates(
            { user_id: userOid, effective_from: input.effective_from, effective_to: input.effective_to ?? null },
            session
        );
        if (overlaps.length > 0) {
            const onlyOne = overlaps.length === 1 ? overlaps[0] : null;
            const isSimpleForwardExtend =
                onlyOne !== null &&
                onlyOne.effective_to === null &&
                onlyOne.effective_from < input.effective_from &&
                input.effective_to === null;
            if (!isSimpleForwardExtend) {
                throw AppError.unprocessable(
                    'New rate would overlap an existing rate for this user — end or remove the conflicting rate first',
                    ERROR_CODES.COST_RATE_INVALID_RANGE,
                    { overlapping_rate_ids: overlaps.map((o) => o._id.toString()) }
                );
            }
            const closingDate = yesterdayOf(input.effective_from);
            if (closingDate < onlyOne.effective_from) {
                throw AppError.unprocessable(
                    'New rate must start AFTER the existing rate for this user — end the predecessor first',
                    ERROR_CODES.COST_RATE_INVALID_RANGE,
                    { existing_rate_id: onlyOne._id.toString(), existing_effective_from: onlyOne.effective_from }
                );
            }
            onlyOne.effective_to = closingDate;
            await onlyOne.save(session ? { session } : undefined);
            previousRateId = onlyOne._id;
        }

        let created: CostRateDocument;
        try {
            const [doc] = await CostRate.create(
                [
                    {
                        user_id: userOid,
                        cost_per_hour: input.cost_per_hour,
                        currency: input.currency,
                        effective_from: input.effective_from,
                        effective_to: input.effective_to ?? null,
                        created_by: caller.id,
                    },
                ],
                session ? { session } : {}
            );
            created = doc;
        } catch (err: unknown) {
            // The `(user_id, effective_from)` unique index turns a
            // parallel-insert race into a deterministic 409 instead of a
            // silent double-row.
            const e = err as { code?: number };
            if (e?.code === 11000) {
                throw AppError.conflict(
                    'A cost rate with this (user, effective_from) already exists',
                    ERROR_CODES.DUPLICATE_RESOURCE,
                    { user_id: userOid.toString(), effective_from: input.effective_from }
                );
            }
            throw err;
        }

        if (caller.audit) {
            await recordAudit(caller.audit, {
                action: AUDIT_ACTIONS.COST_RATE_CREATE,
                target: { kind: AUDIT_TARGET_KINDS.COST_RATE, id: created._id },
                after: toPublic(created),
                metadata: {
                    user_id: userOid.toString(),
                    previous_rate_id: previousRateId?.toString() ?? null,
                },
            });
        }

        return toPublic(created);
    });
};

// ─── PATCH /cost-rates/:id ───────────────────────────────────────────────

export const updateCostRate = async (
    id: Types.ObjectId,
    patch: UpdateCostRateInput,
    caller: CostRateCaller
): Promise<Record<string, unknown>> => {
    const rate = await loadOr404(id);
    const before = toPublic(rate);

    if (patch.cost_per_hour !== undefined) rate.cost_per_hour = patch.cost_per_hour;
    if (patch.effective_to !== undefined) rate.effective_to = patch.effective_to;

    assertRange(rate.effective_from, rate.effective_to);

    await rate.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COST_RATE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.COST_RATE, id: rate._id },
            before,
            after: toPublic(rate),
        });
    }

    return toPublic(rate);
};

// ─── POST /cost-rates/:id/end ────────────────────────────────────────────

export const endCostRate = async (id: Types.ObjectId, caller: CostRateCaller): Promise<Record<string, unknown>> => {
    const rate = await loadOr404(id);

    // Idempotent — re-ending an already-ended rate is a no-op success
    // rather than a silent re-extension. See billing-rate.service.ts's
    // `endRate` for the full rationale.
    if (rate.effective_to !== null) {
        return toPublic(rate);
    }

    const before = toPublic(rate);

    const today = todayLocal();
    // Forward-dated row being ended before it began → collapse to an
    // empty (but valid) range rather than deleting the audit pointer.
    rate.effective_to = today < rate.effective_from ? rate.effective_from : today;
    await rate.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COST_RATE_END,
            target: { kind: AUDIT_TARGET_KINDS.COST_RATE, id: rate._id },
            before,
            after: toPublic(rate),
        });
    }

    return toPublic(rate);
};

// ─── DELETE /cost-rates/:id ──────────────────────────────────────────────
//
// "Only if never used" — `COST_RATE_IN_USE` (409) when any timesheet entry
// for the same `user_id` falls inside the effective range. No project/task
// dimension to narrow by (unlike billing-rate) — cost is per-person.

export const deleteCostRate = async (id: Types.ObjectId, caller: CostRateCaller): Promise<{ deleted: true }> => {
    const rate = await loadOr404(id);

    const usageFilter: Record<string, unknown> = {
        user_id: rate.user_id,
        local_date: { $gte: rate.effective_from },
    };
    if (rate.effective_to !== null) {
        (usageFilter.local_date as Record<string, unknown>).$lte = rate.effective_to;
    }
    const used = await TimesheetEntry.exists(usageFilter);
    if (used) {
        throw AppError.conflict(
            'Cannot delete a cost rate that has already been applied to timesheet entries',
            ERROR_CODES.COST_RATE_IN_USE
        );
    }

    const before = toPublic(rate);
    await rate.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.COST_RATE_DELETE,
            // A cost rate has no name — label it with its amount + start date.
            target: {
                kind: AUDIT_TARGET_KINDS.COST_RATE,
                id: rate._id,
                label: `${rate.cost_per_hour}/hr from ${rate.effective_from}`,
            },
            before,
        });
    }

    return { deleted: true };
};

// ─── GET /cost-rates ─────────────────────────────────────────────────────

interface CostRateUserDisplay {
    id: string;
    full_name: string | null;
}

const loadCostRateUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, CostRateUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(users.map((u) => [u._id.toString(), { id: u._id.toString(), full_name: u.full_name }]));
};

export const listCostRates = async (
    query: ListCostRatesQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    if (query.active_on) {
        filter.effective_from = { $lte: query.active_on };
        filter.$or = [{ effective_to: null }, { effective_to: { $gte: query.active_on } }];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        CostRate.find(filter).sort({ effective_from: -1, _id: -1 }).skip(skip).limit(query.limit),
        CostRate.countDocuments(filter),
    ]);

    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const userMap = await loadCostRateUserDisplays(userIds);

    return {
        data: rows.map((r) => {
            const obj = toPublic(r);
            obj.user = userMap.get(r.user_id.toString()) ?? {
                id: r.user_id.toString(),
                full_name: null,
            };
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

// ─── GET /cost-rates/:id ─────────────────────────────────────────────────

export const getCostRate = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const rate = await loadOr404(id);
    return toPublic(rate);
};

// ─── resolveCostRateForUser ──────────────────────────────────────────────
//
// Rate-at-date lookup consumed by the Task 4 margin service: the cost rate
// whose `[effective_from, effective_to]` window contains `onDate`
// (`effective_to = null` means "current"). Sorted `effective_from` desc so
// a defensive multi-match (shouldn't happen given the write invariants
// above) resolves to the most recent row.

export const resolveCostRateForUser = async (
    userId: Types.ObjectId,
    onDate: string
): Promise<{ cost_per_hour: number; currency: string } | null> => {
    const rate = await CostRate.findOne({
        user_id: userId,
        effective_from: { $lte: onDate },
        $or: [{ effective_to: null }, { effective_to: { $gte: onDate } }],
    }).sort({ effective_from: -1 });

    if (!rate) return null;
    return { cost_per_hour: rate.cost_per_hour, currency: rate.currency };
};
