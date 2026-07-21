import { Types, type ClientSession } from 'mongoose';

import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { withTransaction } from '../utils/with-transaction.js';
import { CompOffLedger, type CompOffLedgerDocument } from '../models/comp-off-ledger.model.js';
import { LeaveBalance, recomputeAvailable } from '../models/leave-balance.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { COMP_OFF_SOURCES, COMP_OFF_TYPES, LEAVE_CODES, type CompOffType } from '../constants/leave.js';
import { ROLES, type RoleType } from '../constants/roles.js';
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
): Promise<{ balance: number; earned: number; consumed: number }> => {
    // Aggregate must run on the same session when a transaction is
    // active so the read sees in-txn writes (e.g. the just-inserted
    // ledger row from `adjustCompOff`'s post-CAS step). When no
    // session is active (most call sites + tests where the
    // aggregate mock returns a plain Promise), call the bare
    // aggregate so we don't depend on the Aggregate chain.
    const aggBuilder = CompOffLedger.aggregate<{ _id: CompOffType; total: number }>([
        { $match: { user_id } },
        { $group: { _id: '$type', total: { $sum: '$days' } } },
    ]);
    const agg = session ? await aggBuilder.session(session) : await aggBuilder;
    let earned = 0;
    let consumed = 0;
    for (const row of agg) {
        if (row._id === COMP_OFF_TYPES.EARNED) earned = row.total;
        if (row._id === COMP_OFF_TYPES.CONSUMED) consumed = row.total;
    }
    const balance = earned - consumed;
    if (session) {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } }, { session });
    } else {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } });
    }
    return { balance, earned, consumed };
};

/**
 * Mirror the comp-off ledger total into `LeaveBalance(user, COMP_OFF, year).adjusted`
 * so the apply-leave engine — which reads availability from `LeaveBalance` —
 * actually sees comp-off grants (BUG-036). The ledger remains the source of
 * truth for the comp-off page (`users.comp_off_balance`); this row is the
 * leave-application's read view, kept in sync at every ledger mutation.
 *
 * We touch the current year only: comp-off is not year-segmented at the
 * grant level, and the apply-leave engine looks up the row by the
 * requested leave's year. If a user wants to spend comp-off in a year
 * other than the current one, that's a separate gap from this bug.
 */
const syncLeaveBalanceForCompOff = async (
    user_id: Types.ObjectId,
    balance: number,
    session?: ClientSession | null
): Promise<void> => {
    const compOffTypeQuery = LeaveType.findOne({ code: LEAVE_CODES.COMP_OFF, is_active: true });
    const compOffType = session ? await compOffTypeQuery.session(session) : await compOffTypeQuery;
    if (!compOffType) return;
    // H3 — `new Date().getFullYear()` uses UTC. An IST-midnight comp-off
    // grant (between 18:30-23:59 UTC on Dec 31) lands in the wrong
    // year's `LeaveBalance` row and the apply-leave engine can't see
    // it. `leave-balance.service.ts` fixed this same bug; comp-off was
    // never updated. Use the canonical IST-aware helper.
    const year = dayjs().tz(DEFAULT_TIMEZONE).year();
    const existingQuery = LeaveBalance.findOne({
        user_id,
        leave_type_id: compOffType._id,
        year,
    });
    const existing = session ? await existingQuery.session(session) : await existingQuery;
    if (existing) {
        existing.adjusted = balance;
        existing.available = recomputeAvailable(existing);
        // Mongoose document `save()` accepts `{ session }`; pass when
        // a transaction is active so the write joins the txn.
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
        adjusted: balance,
        monthly_forfeited: 0,
        available: balance,
    };
    if (session) {
        await LeaveBalance.create([seedDoc], { session });
    } else {
        await LeaveBalance.create(seedDoc);
    }
};

const isReviewer = (role: RoleType): boolean => role === ROLES.ADMIN || role === ROLES.MANAGER;

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
}> => {
    const filter: Filter = { user_id: caller.id };
    const skip = (query.page - 1) * query.limit;
    const [rows, total, totals] = await Promise.all([
        CompOffLedger.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        CompOffLedger.countDocuments(filter),
        recomputeBalance(caller.id),
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
        if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
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

    // H5 — wrap the multi-step write (CAS → ledger.create → recompute
    // → sync) in a transaction so a partial failure rolls back all
    // three stores together. Pre-H5: if `CompOffLedger.create`
    // succeeded but `syncLeaveBalanceForCompOff` crashed, the ledger
    // had a row but the LeaveBalance mirror was stale until the next
    // adjust — the apply-leave engine reads from LeaveBalance, so a
    // user couldn't spend the credit they were just granted.
    //
    // C3 — atomic balance gate (still applies). Pre-C3 a load-then-
    // check pattern raced under concurrent consumes. The CAS below
    // closes the race by atomically decrementing `comp_off_balance`
    // (with a `$gte: days` predicate on consume) so the loser of any
    // race sees `null` and we throw `INSUFFICIENT_LEAVE_BALANCE`.
    const signedDelta = body.type === COMP_OFF_TYPES.EARNED ? body.days : -body.days;
    // M42 — balanceBefore comes from the User row we just read (pre-CAS).
    // The CAS `$inc` mutates `comp_off_balance` atomically; for the audit
    // diff we want the value BEFORE the increment.
    const balanceBefore = target.comp_off_balance ?? 0;
    const txnResult = await withTransaction(async (session) => {
        const casPredicate: Record<string, unknown> = { _id: targetUserId };
        if (body.type === COMP_OFF_TYPES.CONSUMED) {
            // Loser sees null → 409. The race-safe gate.
            casPredicate.comp_off_balance = { $gte: body.days };
        }
        const findOpts: Record<string, unknown> = { new: true };
        if (session) findOpts.session = session;
        const casResult = await User.findOneAndUpdate(
            casPredicate,
            { $inc: { comp_off_balance: signedDelta } },
            findOpts
        );
        if (!casResult) {
            // C3 follow-through — distinguish the two reasons a CAS
            // can return null: (a) consume race-loser (predicate
            // `comp_off_balance: { $gte: days }` failed because the
            // ledger has been drained); (b) the user was deleted
            // between the role-check above and the CAS. Pre-fix both
            // branches threw `INSUFFICIENT_LEAVE_BALANCE`, which on
            // the grant path is misleading copy ("insufficient
            // balance" on a +days grant makes no sense to an admin).
            if (body.type === COMP_OFF_TYPES.CONSUMED) {
                throw AppError.conflict('Insufficient comp-off balance', ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, {
                    available: balanceBefore,
                    requested: body.days,
                });
            }
            // Grant CAS predicate is just `{ _id }` — null means the
            // user vanished mid-adjust. Treat as not-found.
            throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
        }

        const createPayload = {
            user_id: targetUserId,
            type: body.type,
            days: body.days,
            source_type: COMP_OFF_SOURCES.ADMIN_ADJUSTMENT,
            source_ref_id: null,
            remarks: body.remarks,
            created_by: actor.id,
        };
        const ledgerInTxn = session
            ? (await CompOffLedger.create([createPayload], { session }))[0]!
            : await CompOffLedger.create(createPayload);

        // M42 — `balanceAfter` is the CAS's returned value (the row
        // post-`$inc`). Pre-M42 we re-aggregated the full ledger here
        // for "idempotent reconciliation"; the CAS is already
        // atomically correct, and the nightly comp-off-reconciliation
        // cron is the safety net for drift.
        const balanceAfter = casResult.comp_off_balance ?? 0;

        // BUG-036 — keep the leave-application read view in sync.
        await syncLeaveBalanceForCompOff(targetUserId, balanceAfter, session);

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
                delta: signedDelta,
                remarks: body.remarks ?? null,
            },
        });
    }

    return { ledger: toPublic(ledger), balance: balanceAfter };
};
