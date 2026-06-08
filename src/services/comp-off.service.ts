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

const recomputeBalance = async (user_id: Types.ObjectId, session?: ClientSession | null): Promise<number> => {
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
    // Omit `session` entirely when no transaction is active so tests
    // that strict-match the third arg via `toHaveBeenNthCalledWith`
    // keep the pre-H5 call shape. Mirrors `releaseReservations` (C2).
    if (session) {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } }, { session });
    } else {
        await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } });
    }
    return balance;
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
}> => {
    const filter: Filter = { user_id: caller.id };
    const skip = (query.page - 1) * query.limit;
    const [rows, total, balance] = await Promise.all([
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
        balance,
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
    query: ListCompOffQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
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
    const target = await User.findById(targetUserId).select('role');
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
    const txnResult = await withTransaction(async (session) => {
        // Capture the pre-adjust balance for the audit before/after
        // diff. Runs inside the txn so any concurrent CAS that lost
        // the race is invisible to this read.
        const balanceBefore = await recomputeBalance(targetUserId, session);

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
            // Only the consume path can land here (grant has no
            // predicate beyond `_id`; target was validated above).
            throw AppError.conflict('Insufficient comp-off balance', ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, {
                available: balanceBefore,
                requested: body.days,
            });
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

        // Reconciles `User.comp_off_balance` against the ledger sum.
        // Idempotent — should produce the same value the CAS already
        // set; runs inside the txn so the read sees the just-inserted
        // ledger row.
        const balanceAfter = await recomputeBalance(targetUserId, session);

        // BUG-036 — keep the leave-application read view in sync.
        await syncLeaveBalanceForCompOff(targetUserId, balanceAfter, session);

        return { ledger: ledgerInTxn, balanceBefore, balanceAfter };
    });
    const { ledger, balanceBefore, balanceAfter } = txnResult;

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
