import { Types } from 'mongoose';

import { CompOffLedger, type CompOffLedgerDocument } from '../models/comp-off-ledger.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { COMP_OFF_SOURCES, COMP_OFF_TYPES, type CompOffType } from '../constants/leave.js';
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

const recomputeBalance = async (user_id: Types.ObjectId): Promise<number> => {
    const agg = await CompOffLedger.aggregate<{ _id: CompOffType; total: number }>([
        { $match: { user_id } },
        { $group: { _id: '$type', total: { $sum: '$days' } } },
    ]);
    let earned = 0;
    let consumed = 0;
    for (const row of agg) {
        if (row._id === COMP_OFF_TYPES.EARNED) earned = row.total;
        if (row._id === COMP_OFF_TYPES.CONSUMED) consumed = row.total;
    }
    const balance = earned - consumed;
    await User.updateOne({ _id: user_id }, { $set: { comp_off_balance: balance } });
    return balance;
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
    const userExists = await User.exists({ _id: targetUserId });
    if (!userExists) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    // Guard against driving balance negative on a `consume` adjustment.
    // Capture the pre-adjust balance for the audit before/after diff so
    // the audit row reflects the actual transition rather than recomputing
    // again post-write.
    const balanceBefore = await recomputeBalance(targetUserId);
    if (body.type === COMP_OFF_TYPES.CONSUMED) {
        if (balanceBefore < body.days) {
            throw AppError.conflict('Insufficient comp-off balance', ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, {
                available: balanceBefore,
                requested: body.days,
            });
        }
    }

    const ledger = await CompOffLedger.create({
        user_id: targetUserId,
        type: body.type,
        days: body.days,
        source_type: COMP_OFF_SOURCES.ADMIN_ADJUSTMENT,
        source_ref_id: null,
        remarks: body.remarks,
        created_by: actor.id,
    });

    const balanceAfter = await recomputeBalance(targetUserId);

    if (audit) {
        // I1 — sensitive admin write: signed delta + operator-supplied
        // remarks land in the audit row so a future dispute resolution
        // can trace who granted/consumed comp-off and why. Pre-I1 the
        // adjust ran with no audit trail — the only durable record was
        // the ledger row itself, which doesn't carry actor context
        // beyond `created_by`.
        const signedDelta = body.type === COMP_OFF_TYPES.EARNED ? body.days : -body.days;
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
