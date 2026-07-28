import { Types, type ClientSession } from 'mongoose';

import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { withTransaction } from '../utils/with-transaction.js';
import {
    CompOffLedger,
    type CompOffAllocation,
    type CompOffContribution,
    type CompOffLedgerDocument,
} from '../models/comp-off-ledger.model.js';
import { LeaveBalance, recomputeAvailable } from '../models/leave-balance.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import {
    COMP_OFF_EXPIRING_SOON_DAYS,
    COMP_OFF_EXPIRY_MONTHS,
    COMP_OFF_SOURCES,
    COMP_OFF_TYPES,
    LEAVE_CODES,
    type CompOffSource,
} from '../constants/leave.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { scopedUserIdFilter } from './reporting-scope.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { AdjustCompOffBody, ListCompOffQuery, MyCompOffQuery } from '../validators/comp-off.validator.js';
import { recordAudit, type AuditContext } from './audit.service.js';

/**
 * Comp-off ledger service (API_Contract.md §5.9, Data_Model.md §3.4).
 *
 * Append-only. The user-facing balance lives at `users.comp_off_balance`
 * and is recomputed every time we insert a row so reads never have to
 * scan the ledger.
 *
 * Sign convention: `days` is always positive; `type` carries the sign
 * (`earned` adds, `consumed` subtracts).
 */

type Filter = Record<string, unknown>;

const toPublic = (doc: CompOffLedgerDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

/**
 * M42 — aggregate the ledger and overwrite `User.comp_off_balance`.
 *
 * Pre-M42 this fired on every `adjustCompOff` (twice — before AND
 * after the CAS) for partial-failure recovery. The hot path now
 * trusts the CAS `$inc` for balance maintenance (C3 already does
 * this), and `recomputeBalance` is reserved for the nightly
 * reconciliation cron (`jobs/comp-off-reconciliation.job.ts`) that
 * detects + repairs drift.
 *
 * Exported so the cron can call it; the implementation is unchanged
 * from pre-M42 except for the session-optional behaviour.
 */
export const recomputeBalance = async (
    user_id: Types.ObjectId,
    session?: ClientSession | null
): Promise<{ balance: number; earned: number; consumed: number; expired: number }> => {
    // Balance is authoritative from the LOTS: Σ remaining_days over non-expired
    // earned rows. `consumed`/`expired` rows are history only. `earned`/
    // `consumed`/`expired` totals are surfaced for the page's stat tiles.
    //
    // Aggregate must run on the same session when a transaction is active so the
    // read sees in-txn writes. When no session is active (most call sites + the
    // tests where the aggregate mock returns a plain Promise) call it bare.
    const aggBuilder = CompOffLedger.aggregate<{
        _id: null;
        balance: number;
        earned: number;
        consumed: number;
        expired: number;
    }>([
        { $match: { user_id } },
        {
            $group: {
                _id: null,
                balance: {
                    $sum: {
                        $cond: [
                            { $and: [{ $eq: ['$type', COMP_OFF_TYPES.EARNED] }, { $ne: ['$expired', true] }] },
                            '$remaining_days',
                            0,
                        ],
                    },
                },
                earned: { $sum: { $cond: [{ $eq: ['$type', COMP_OFF_TYPES.EARNED] }, '$days', 0] } },
                consumed: {
                    $sum: {
                        $cond: [
                            { $and: [{ $eq: ['$type', COMP_OFF_TYPES.CONSUMED] }, { $eq: ['$reversed_at', null] }] },
                            '$days',
                            0,
                        ],
                    },
                },
                expired: { $sum: { $cond: [{ $eq: ['$type', COMP_OFF_TYPES.EXPIRED] }, '$days', 0] } },
            },
        },
    ]);
    const agg = session ? await aggBuilder.session(session) : await aggBuilder;
    const row = agg[0];
    const balance = row?.balance ?? 0;
    const earned = row?.earned ?? 0;
    const consumed = row?.consumed ?? 0;
    const expired = row?.expired ?? 0;
    if (session) {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } }, { session });
    } else {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } });
    }
    return { balance, earned, consumed, expired };
};

/**
 * Gross non-expired earned pool = Σ `days` over non-expired lots. This is what
 * the leave mirror's `adjusted` must hold: the engine tracks `used`/`pending`
 * on top, so `available = gross − used − pending`. (Balance above is the NET
 * `Σ remaining_days`; `gross − Σ remaining = consumed-from-live-lots`.)
 */
export const grossEarnedPool = async (user_id: Types.ObjectId, session?: ClientSession | null): Promise<number> => {
    const aggBuilder = CompOffLedger.aggregate<{ _id: null; gross: number }>([
        { $match: { user_id, type: COMP_OFF_TYPES.EARNED, expired: { $ne: true } } },
        { $group: { _id: null, gross: { $sum: '$days' } } },
    ]);
    const agg = session ? await aggBuilder.session(session) : await aggBuilder;
    return agg[0]?.gross ?? 0;
};

/** Source date (or now) + COMP_OFF_EXPIRY_MONTHS, as a Date. */
export const compOffExpiryFrom = (sourceDate: string | Date | null): Date => {
    const base = sourceDate ? dayjs.tz(sourceDate as string, DEFAULT_TIMEZONE) : dayjs().tz(DEFAULT_TIMEZONE);
    return base.add(COMP_OFF_EXPIRY_MONTHS, 'month').endOf('day').toDate();
};

// ─── Lot helpers (create / draw FIFO / consume / refund / expire) ──────────

export interface CreateEarnedLotParams {
    user_id: Types.ObjectId;
    days: number;
    source_type: CompOffSource;
    source_ref_id?: Types.ObjectId | null;
    project_id?: Types.ObjectId | null;
    project_name?: string | null;
    source_minutes?: number;
    source_date?: string | null;
    contributions?: CompOffContribution[];
    remarks?: string;
    created_by?: Types.ObjectId | null;
    expires_at?: Date;
}

/** Insert a fresh EARNED lot (admin grant / accrual). `remaining_days = days`. */
export const createEarnedLot = async (
    params: CreateEarnedLotParams,
    session?: ClientSession | null
): Promise<CompOffLedgerDocument> => {
    const payload = {
        user_id: params.user_id,
        type: COMP_OFF_TYPES.EARNED,
        days: params.days,
        remaining_days: params.days,
        expires_at: params.expires_at ?? compOffExpiryFrom(params.source_date ?? null),
        expired: false,
        source_type: params.source_type,
        source_ref_id: params.source_ref_id ?? null,
        project_id: params.project_id ?? null,
        project_name: params.project_name ?? null,
        source_minutes: params.source_minutes ?? 0,
        source_date: params.source_date ?? null,
        contributions: params.contributions ?? [],
        allocations: [],
        reversed_at: null,
        remarks: params.remarks ?? '',
        created_by: params.created_by ?? null,
    };
    return session ? (await CompOffLedger.create([payload], { session }))[0]! : await CompOffLedger.create(payload);
};

/**
 * FIFO-draw `days` from a user's oldest-expiring active lots, decrementing each
 * lot's `remaining_days`. Returns the allocations (for refund). Throws
 * INSUFFICIENT_LEAVE_BALANCE if the live lots can't cover `days`.
 */
export const drawLotsFIFO = async (
    user_id: Types.ObjectId,
    days: number,
    session?: ClientSession | null
): Promise<CompOffAllocation[]> => {
    const q = CompOffLedger.find({
        user_id,
        type: COMP_OFF_TYPES.EARNED,
        expired: { $ne: true },
        remaining_days: { $gt: 0 },
    }).sort({ expires_at: 1, created_at: 1 });
    const lots = session ? await q.session(session) : await q;

    let need = days;
    const allocations: CompOffAllocation[] = [];
    for (const lot of lots) {
        if (need <= 1e-9) break;
        const take = Math.min(lot.remaining_days, need);
        lot.remaining_days = Number((lot.remaining_days - take).toFixed(2));
        await (session ? lot.save({ session }) : lot.save());
        allocations.push({ lot_id: lot._id, days: Number(take.toFixed(2)) });
        need = Number((need - take).toFixed(2));
    }
    if (need > 1e-9) {
        throw AppError.conflict('Insufficient comp-off balance', ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, {
            requested: days,
            short_by: Number(need.toFixed(2)),
        });
    }
    return allocations;
};

/**
 * Consume `days` of comp-off: FIFO-draw lots and write ONE `consumed` history
 * row carrying the allocations (so a later cancel can refund the exact lots).
 */
export const consumeCompOffLots = async (
    params: {
        user_id: Types.ObjectId;
        days: number;
        source_type: CompOffSource;
        source_ref_id?: Types.ObjectId | null;
        remarks?: string;
        created_by?: Types.ObjectId | null;
    },
    session?: ClientSession | null
): Promise<CompOffLedgerDocument> => {
    const allocations = await drawLotsFIFO(params.user_id, params.days, session);
    const payload = {
        user_id: params.user_id,
        type: COMP_OFF_TYPES.CONSUMED,
        days: params.days,
        remaining_days: 0,
        expires_at: null,
        expired: false,
        source_type: params.source_type,
        source_ref_id: params.source_ref_id ?? null,
        allocations,
        reversed_at: null,
        remarks: params.remarks ?? '',
        created_by: params.created_by ?? null,
    };
    return session ? (await CompOffLedger.create([payload], { session }))[0]! : await CompOffLedger.create(payload);
};

/**
 * Reverse the `consumed` row for a given (source_type, source_ref_id) — restore
 * each named lot's `remaining_days` (skipping lots that have since expired) and
 * mark the row reversed. Used when an approved comp-off leave is cancelled.
 */
export const refundConsumedLots = async (
    match: { source_type: CompOffSource; source_ref_id: Types.ObjectId },
    session?: ClientSession | null
): Promise<boolean> => {
    const q = CompOffLedger.findOne({
        type: COMP_OFF_TYPES.CONSUMED,
        source_type: match.source_type,
        source_ref_id: match.source_ref_id,
        reversed_at: null,
    });
    const consumedRow = session ? await q.session(session) : await q;
    if (!consumedRow) return false;

    for (const alloc of consumedRow.allocations) {
        const lq = CompOffLedger.findById(alloc.lot_id);
        const lot = session ? await lq.session(session) : await lq;
        if (lot && !lot.expired) {
            lot.remaining_days = Number(Math.min(lot.days, lot.remaining_days + alloc.days).toFixed(2));
            await (session ? lot.save({ session }) : lot.save());
        }
        // Lot expired since consumption → those days are gone; nothing to refund.
    }
    consumedRow.reversed_at = new Date();
    await (session ? consumedRow.save({ session }) : consumedRow.save());
    return true;
};

/**
 * Expire every earned lot whose `expires_at <= asOf` and still has unconsumed
 * `remaining_days`: write an `expired` history row for the lost days, zero the
 * lot, mark it expired. Returns per-user totals so the job can notify. Each lot
 * is its own transaction (re-checked inside) so re-runs never double-expire.
 */
export const expireDueLots = async (
    asOf: Date = new Date()
): Promise<{ lotsExpired: number; perUser: Map<string, number> }> => {
    const dueLots = await CompOffLedger.find({
        type: COMP_OFF_TYPES.EARNED,
        expired: { $ne: true },
        remaining_days: { $gt: 0 },
        expires_at: { $ne: null, $lte: asOf },
    })
        .select({ _id: 1, user_id: 1 })
        .lean<{ _id: Types.ObjectId; user_id: Types.ObjectId }[]>();

    const perUser = new Map<string, number>();
    let lotsExpired = 0;

    for (const ref of dueLots) {
        const applied = await withTransaction(async (session) => {
            const lq = CompOffLedger.findOne({ _id: ref._id, expired: { $ne: true } });
            const lot = session ? await lq.session(session) : await lq;
            if (!lot || lot.remaining_days <= 0) return 0; // raced / already handled
            const lost = lot.remaining_days;
            await createExpiredRow(lot, lost, session);
            lot.expired = true;
            lot.remaining_days = 0;
            await (session ? lot.save({ session }) : lot.save());
            return lost;
        });
        if (applied > 0) {
            lotsExpired += 1;
            const key = ref.user_id.toString();
            perUser.set(key, Number(((perUser.get(key) ?? 0) + applied).toFixed(2)));
        }
    }

    // Re-sync each touched user's cached balance + leave mirror once.
    for (const uid of perUser.keys()) {
        await resyncCompOff(new Types.ObjectId(uid)).catch(() => undefined);
    }
    return { lotsExpired, perUser };
};

/** Write the `expired` history row for a lapsed lot. */
const createExpiredRow = async (
    lot: CompOffLedgerDocument,
    days: number,
    session?: ClientSession | null
): Promise<void> => {
    const payload = {
        user_id: lot.user_id,
        type: COMP_OFF_TYPES.EXPIRED,
        days,
        remaining_days: 0,
        expires_at: null,
        expired: false,
        source_type: lot.source_type,
        source_ref_id: lot._id,
        project_id: lot.project_id,
        project_name: lot.project_name,
        // NOT the lot's source_date: the parent lot keeps its (user, source_type,
        // source_date) row, and the partial-unique index would reject a second
        // one. The lot ref lives in source_ref_id; the worked date is derivable.
        source_date: null,
        source_minutes: lot.source_minutes,
        allocations: [],
        reversed_at: null,
        remarks: `Expired ${days} unused comp-off day(s)`,
        created_by: null,
    };
    if (session) await CompOffLedger.create([payload], { session });
    else await CompOffLedger.create(payload);
};

/**
 * Mirror the comp-off GROSS pool into `LeaveBalance(user, COMP_OFF, year).adjusted`
 * so the apply-leave engine — which reads availability from `LeaveBalance` —
 * sees comp-off grants (BUG-036) without double-counting consumption.
 *
 * `adjusted` = Σ `days` over non-expired earned lots (the gross pool, NOT the
 * net balance). The engine tracks `used`/`pending` on top, so `available =
 * gross − used − pending`. Lot `remaining_days` (net) drives FIFO + expiry and
 * equals `gross − used`; that's why `adjusted` must be gross, not net — else
 * leave-consume (which draws a lot AND increments `used`) would subtract twice.
 *
 * Current year only (comp-off isn't year-segmented at grant level; the engine
 * looks the row up by the requested leave's year — H3 IST-aware).
 */
export const syncLeaveBalanceForCompOff = async (
    user_id: Types.ObjectId,
    session?: ClientSession | null
): Promise<void> => {
    const compOffTypeQuery = LeaveType.findOne({ code: LEAVE_CODES.COMP_OFF, is_active: true });
    const compOffType = session ? await compOffTypeQuery.session(session) : await compOffTypeQuery;
    if (!compOffType) return;
    const gross = await grossEarnedPool(user_id, session);
    const year = dayjs().tz(DEFAULT_TIMEZONE).year();
    const existingQuery = LeaveBalance.findOne({
        user_id,
        leave_type_id: compOffType._id,
        year,
    });
    const existing = session ? await existingQuery.session(session) : await existingQuery;
    if (existing) {
        existing.adjusted = gross;
        existing.available = recomputeAvailable(existing);
        await (session ? existing.save({ session }) : existing.save());
        return;
    }
    const seedDoc = {
        user_id,
        leave_type_id: compOffType._id,
        year,
        allocated: 0,
        carried_forward: 0,
        used: 0,
        pending: 0,
        adjusted: gross,
        monthly_forfeited: 0,
        available: gross,
    };
    if (session) {
        await LeaveBalance.create([seedDoc], { session });
    } else {
        await LeaveBalance.create(seedDoc);
    }
};

const isReviewer = (role: RoleType): boolean => role === ROLES.ADMIN || role === ROLES.MANAGER;

/** Recompute the cached balance AND re-mirror the gross pool together. Call
 *  after any lot mutation (grant / consume / refund / expire). */
export const resyncCompOff = async (
    user_id: Types.ObjectId,
    session?: ClientSession | null
): Promise<{ balance: number; earned: number; consumed: number; expired: number }> => {
    const totals = await recomputeBalance(user_id, session);
    await syncLeaveBalanceForCompOff(user_id, session);
    return totals;
};

/** Active days expiring within COMP_OFF_EXPIRING_SOON_DAYS + the soonest date. */
export const compOffExpiringSoon = async (
    user_id: Types.ObjectId
): Promise<{ days: number; next_expiry_at: string | null }> => {
    const now = dayjs().tz(DEFAULT_TIMEZONE);
    const soonCutoff = now.add(COMP_OFF_EXPIRING_SOON_DAYS, 'day').endOf('day').toDate();
    const lots = await CompOffLedger.find({
        user_id,
        type: COMP_OFF_TYPES.EARNED,
        expired: { $ne: true },
        remaining_days: { $gt: 0 },
        expires_at: { $ne: null, $lte: soonCutoff },
    })
        .select({ remaining_days: 1, expires_at: 1 })
        .sort({ expires_at: 1 })
        .lean<{ remaining_days: number; expires_at: Date }[]>();
    const days = lots.reduce((a, l) => a + l.remaining_days, 0);
    return {
        days: Number(days.toFixed(2)),
        next_expiry_at: lots[0]?.expires_at ? lots[0].expires_at.toISOString() : null,
    };
};

// ─── GET /comp-off/me ─────────────────────────────────────────────────────

export const listOwnCompOff = async (
    query: MyCompOffQuery,
    caller: { id: Types.ObjectId }
): Promise<{
    data: Record<string, unknown>[];
    meta: PaginationMeta;
    balance: number;
    /** All-time totals across the whole ledger (not just this page). */
    earned_total: number;
    consumed_total: number;
    expired_total: number;
    /** Active days lapsing within the warning window, + the soonest expiry. */
    expiring_soon_days: number;
    next_expiry_at: string | null;
}> => {
    const filter: Filter = { user_id: caller.id };
    const skip = (query.page - 1) * query.limit;
    const [rows, total, totals, soon] = await Promise.all([
        CompOffLedger.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        CompOffLedger.countDocuments(filter),
        recomputeBalance(caller.id),
        compOffExpiringSoon(caller.id),
    ]);
    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
        balance: totals.balance,
        earned_total: totals.earned,
        consumed_total: totals.consumed,
        expired_total: totals.expired,
        expiring_soon_days: soon.days,
        next_expiry_at: soon.next_expiry_at,
    };
};

// ─── GET /comp-off ────────────────────────────────────────────────────────

/**
 * Per-page user-display hydration — mirrors the audit-log / attendance /
 * leaves pattern so the admin ledger view can render names without an
 * N+1 to `/users/:id`.
 */
interface CompOffUserDisplay {
    id: string;
    full_name: string | null;
}

const loadCompOffUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, CompOffUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(users.map((u) => [u._id.toString(), { id: u._id.toString(), full_name: u.full_name }]));
};

export const listCompOff = async (
    query: ListCompOffQuery,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    // `COMP_OFF_READ` is in the employee bundle (it gates the route for a
    // user's OWN /comp-off page), so a non-reviewer reaching this list
    // endpoint must be scoped to their own ledger — otherwise they could
    // enumerate the whole org's comp-off (names + days + remarks). Only
    // reviewers (admin/manager) get the org-wide view. Mirrors the
    // attendance / leave-balance team-read gating.
    if (isReviewer(caller.role)) {
        // Reporting-chain scoping — Admin sees all; Manager only their direct
        // reports. `undefined` → no user_id restriction (admin, no drill).
        const scopedUid = await scopedUserIdFilter(caller, query.user_id);
        if (scopedUid !== undefined) filter.user_id = scopedUid;
    } else {
        filter.user_id = caller.id;
    }
    if (query.type) filter.type = query.type;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        CompOffLedger.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        CompOffLedger.countDocuments(filter),
    ]);

    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const userMap = await loadCompOffUserDisplays(userIds);

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

// ─── POST /comp-off/adjust ────────────────────────────────────────────────

export const adjustCompOff = async (
    body: AdjustCompOffBody,
    actor: { id: Types.ObjectId; role: RoleType },
    audit?: AuditContext
): Promise<{ ledger: Record<string, unknown>; balance: number }> => {
    if (!isReviewer(actor.role)) throw AppError.forbidden();

    const targetUserId = new Types.ObjectId(body.user_id);
    // M42 — fetch `comp_off_balance` alongside `role` in the same
    // read so the post-CAS audit `before` snapshot doesn't need a
    // second aggregation over the ledger. CAS maintains the balance;
    // this read is the snapshot, not the source of truth.
    const target = await User.findById(targetUserId).select('role comp_off_balance');
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    // BUG-037 — clients are external; comp-off is a staff-only construct.
    // The Adjust dialog already filters clients out of the picker, but a
    // direct API caller (curl, a stale window, future tooling) must also
    // be rejected with an explicit error rather than silently creating
    // ledger rows that can never be consumed via leave.
    if (target.role === ROLES.CLIENT) {
        throw AppError.unprocessable('Comp-off cannot be assigned to clients', ERROR_CODES.FORBIDDEN_ROLE_TARGET, {
            role: target.role,
        });
    }

    // Lot-based: an EARNED adjust creates a fresh lot (3-month expiry from now);
    // a CONSUMED adjust FIFO-draws the oldest active lots (throwing
    // INSUFFICIENT_LEAVE_BALANCE if the live lots can't cover it). The whole
    // write (lot mutation → recompute → mirror) is one transaction so a partial
    // failure rolls back together (H5). `drawLotsFIFO` is the race-safe gate:
    // concurrent consumers can't both draw the same lot's remaining_days.
    const balanceBefore = target.comp_off_balance ?? 0;
    const txnResult = await withTransaction(async (session) => {
        const ledgerInTxn =
            body.type === COMP_OFF_TYPES.EARNED
                ? await createEarnedLot(
                      {
                          user_id: targetUserId,
                          days: body.days,
                          source_type: COMP_OFF_SOURCES.ADMIN_ADJUSTMENT,
                          remarks: body.remarks,
                          created_by: actor.id,
                      },
                      session
                  )
                : await consumeCompOffLots(
                      {
                          user_id: targetUserId,
                          days: body.days,
                          source_type: COMP_OFF_SOURCES.ADMIN_ADJUSTMENT,
                          remarks: body.remarks,
                          created_by: actor.id,
                      },
                      session
                  );

        const { balance: balanceAfter } = await resyncCompOff(targetUserId, session);
        return { ledger: ledgerInTxn, balanceAfter };
    });
    const { ledger, balanceAfter } = txnResult;

    if (audit) {
        // I1 — sensitive admin write: signed delta + operator-supplied
        // remarks land in the audit row so a future dispute resolution
        // can trace who granted/consumed comp-off and why. Pre-I1 the
        // adjust ran with no audit trail — the only durable record was
        // the ledger row itself, which doesn't carry actor context
        // beyond `created_by`.
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.COMP_OFF_ADJUST,
            target: { kind: AUDIT_TARGET_KINDS.COMP_OFF_LEDGER, id: ledger._id },
            before: { balance: balanceBefore },
            after: { balance: balanceAfter },
            metadata: {
                user_id: targetUserId.toString(),
                type: body.type,
                delta: body.type === COMP_OFF_TYPES.EARNED ? body.days : -body.days,
                remarks: body.remarks ?? null,
            },
        });
    }

    return { ledger: toPublic(ledger), balance: balanceAfter };
};
