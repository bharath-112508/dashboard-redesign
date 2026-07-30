import { Types } from 'mongoose';

import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance } from '../models/leave-balance.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { LEAVE_TYPE_SEEDS, RETIRED_LEAVE_TYPE_CODES, type LeaveCode } from '../constants/leave.js';
import { uniqueCodeFromName } from '../utils/leave-type-code.js';
import logger from '../utils/logger.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { CreateLeaveTypeBody, PatchLeaveTypeBody } from '../validators/leave-type.validator.js';

/**
 * Leave-type service (API_Contract.md §5.1, Data_Model.md §3.1).
 *
 * Seeding is `setOnInsert`-only so admin overrides survive restarts:
 *  - Missing canonical types (CL, SL, …) get inserted with the defaults
 *    from `LEAVE_TYPE_SEEDS`.
 *  - Existing rows are left untouched — admin tweaks (custom names,
 *    advance-notice, etc.) won't be reverted.
 *
 * `code` is the natural key. We do not allow code edits via PATCH because
 * the engine + balance lookups rely on stable codes.
 *
 * Hard-delete is forbidden — `POST /:id/deactivate` flips `is_active=false`
 * and the apply form filters those out, but historical balance rows + leave
 * segments still resolve.
 */

type Filter = Record<string, unknown>;

const toPublic = (doc: LeaveTypeDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;
const toPublicMany = (docs: LeaveTypeDocument[]): Record<string, unknown>[] => docs.map(toPublic);

const isE11000 = (err: unknown): err is { code: 11000; keyValue?: { code?: string } } =>
    !!err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000;

// ─── Boot-time seed ────────────────────────────────────────────────────────

export const seedDefaultLeaveTypes = async (): Promise<{ inserted: LeaveCode[]; skipped: LeaveCode[] }> => {
    const inserted: LeaveCode[] = [];
    const skipped: LeaveCode[] = [];
    for (const seed of LEAVE_TYPE_SEEDS) {
        try {
            const result = await LeaveType.updateOne({ code: seed.code }, { $setOnInsert: seed }, { upsert: true });
            if (result.upsertedCount && result.upsertedCount > 0) {
                inserted.push(seed.code);
            } else {
                skipped.push(seed.code);
            }
        } catch (err: unknown) {
            // Race condition between two boots (multiple replicas); harmless.
            if (isE11000(err)) {
                skipped.push(seed.code);
                continue;
            }
            throw err;
        }
    }
    if (inserted.length > 0) {
        logger.info({ inserted, skipped }, 'Seeded default leave types');
    } else {
        logger.debug({ skipped }, 'Default leave types already seeded');
    }
    // Self-healing: drop any retired types a stale process / old branch may
    // have re-seeded, so removal actually sticks across boots.
    await pruneRetiredLeaveTypes();
    return { inserted, skipped };
};

/**
 * Delete any leave type whose code is in `RETIRED_LEAVE_TYPE_CODES`, along
 * with its zero-usage balance rows. A retired type that has real leave
 * requests is kept (and logged) rather than silently deleted — historical
 * requests must still resolve their type. Runs on every boot via
 * `seedDefaultLeaveTypes`, and is idempotent (a no-op once nothing matches).
 */
export const pruneRetiredLeaveTypes = async (): Promise<{ removed: string[]; kept: string[] }> => {
    const removed: string[] = [];
    const kept: string[] = [];
    const retired = await LeaveType.find({
        code: { $in: RETIRED_LEAVE_TYPE_CODES as unknown as string[] },
    }).select('_id code');
    for (const t of retired) {
        const inUse = await LeaveRequest.exists({ leave_type_id: t._id });
        if (inUse) {
            kept.push(t.code);
            continue;
        }
        await LeaveBalance.deleteMany({ leave_type_id: t._id });
        await LeaveType.deleteOne({ _id: t._id });
        removed.push(t.code);
    }
    if (removed.length > 0) {
        logger.info({ removed, kept }, 'Pruned retired leave types');
    } else if (kept.length > 0) {
        logger.warn({ kept }, 'Retired leave types kept — they have leave requests');
    }
    return { removed, kept };
};

// ─── GET /leave-types ─────────────────────────────────────────────────────

export const listLeaveTypes = async (filters: {
    is_active?: boolean;
    show_deleted?: boolean;
}): Promise<Record<string, unknown>[]> => {
    const filter: Filter = {};
    if (filters.is_active !== undefined) filter.is_active = filters.is_active;
    // BUG-002 — hide soft-deleted (is_active=false) rows by default; opt-in
    // via `show_deleted=true`. Explicit `is_active=...` wins.
    else if (!filters.show_deleted) filter.is_active = true;
    const rows = await LeaveType.find(filter).sort({ code: 1 });
    return toPublicMany(rows);
};

// ─── POST /leave-types ────────────────────────────────────────────────────

export const createLeaveType = async (
    input: CreateLeaveTypeBody,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    // No code supplied → derive it from the name. Read the taken set first
    // so a repeated name lands on NAME_2 instead of dead-ending on the
    // unique index, which the admin can no longer resolve by hand now that
    // the field is gone from the form. A concurrent create can still race
    // to the same suffix; the E11000 below is the backstop.
    let code = input.code;
    if (!code) {
        const existing = await LeaveType.find({}, { code: 1 }).lean();
        code = uniqueCodeFromName(input.name, new Set(existing.map((r) => String(r.code))));
    }
    try {
        const doc = await LeaveType.create({
            code,
            name: input.name,
            default_allocation_days: input.default_allocation_days,
            carry_forward: input.carry_forward,
            carry_forward_cap: input.carry_forward_cap ?? null,
            monthly_cap: input.monthly_cap ?? null,
            monthly_forfeiture: input.monthly_forfeiture,
            is_unlimited: input.is_unlimited,
            is_earned: input.is_earned,
            is_event_based: input.is_event_based,
            pro_rata_on_join: input.pro_rata_on_join as LeaveTypeDocument['pro_rata_on_join'],
            supports_half_day: input.supports_half_day,
            advance_notice_days: input.advance_notice_days,
            resets_yearly: input.resets_yearly,
            is_active: input.is_active ?? true,
        });
        if (audit) {
            await recordAudit(audit, {
                action: AUDIT_ACTIONS.LEAVE_TYPE_CREATE,
                target: { kind: AUDIT_TARGET_KINDS.LEAVE_TYPE, id: doc._id },
                after: toPublic(doc),
            });
        }
        return toPublic(doc);
    } catch (err: unknown) {
        if (isE11000(err)) {
            throw AppError.conflict(`Leave type "${code}" already exists`, ERROR_CODES.DUPLICATE_RESOURCE, {
                code,
            });
        }
        throw err;
    }
};

// ─── PATCH /leave-types/:id ───────────────────────────────────────────────

export const updateLeaveType = async (
    id: Types.ObjectId,
    patch: PatchLeaveTypeBody,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const doc = await LeaveType.findById(id);
    if (!doc) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    const before = toPublic(doc);

    if (patch.name !== undefined) doc.name = patch.name;
    if (patch.default_allocation_days !== undefined) doc.default_allocation_days = patch.default_allocation_days;
    if (patch.carry_forward !== undefined) doc.carry_forward = patch.carry_forward;
    if (patch.carry_forward_cap !== undefined) doc.carry_forward_cap = patch.carry_forward_cap;
    if (patch.monthly_cap !== undefined) doc.monthly_cap = patch.monthly_cap;
    if (patch.monthly_forfeiture !== undefined) doc.monthly_forfeiture = patch.monthly_forfeiture;
    if (patch.is_unlimited !== undefined) doc.is_unlimited = patch.is_unlimited;
    if (patch.is_earned !== undefined) doc.is_earned = patch.is_earned;
    if (patch.is_event_based !== undefined) doc.is_event_based = patch.is_event_based;
    if (patch.pro_rata_on_join !== undefined)
        doc.pro_rata_on_join = patch.pro_rata_on_join as typeof doc.pro_rata_on_join;
    if (patch.supports_half_day !== undefined) doc.supports_half_day = patch.supports_half_day;
    if (patch.advance_notice_days !== undefined) doc.advance_notice_days = patch.advance_notice_days;
    if (patch.resets_yearly !== undefined) doc.resets_yearly = patch.resets_yearly;
    if (patch.is_active !== undefined) doc.is_active = patch.is_active;

    await doc.save();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.LEAVE_TYPE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_TYPE, id: doc._id },
            before,
            after: toPublic(doc),
        });
    }

    return toPublic(doc);
};

// ─── POST /leave-types/:id/deactivate ─────────────────────────────────────

export const deactivateLeaveType = async (
    id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const doc = await LeaveType.findById(id);
    if (!doc) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (doc.is_active) {
        doc.is_active = false;
        await doc.save();
        if (audit) {
            await recordAudit(audit, {
                action: AUDIT_ACTIONS.LEAVE_TYPE_DEACTIVATE,
                target: { kind: AUDIT_TARGET_KINDS.LEAVE_TYPE, id: doc._id },
                before: { is_active: true },
                after: { is_active: false },
            });
        }
    }
    return toPublic(doc);
};

// ─── Internal: lookup helpers used by other services ──────────────────────

export const getLeaveTypeByCode = async (code: string): Promise<LeaveTypeDocument | null> => {
    return LeaveType.findOne({ code });
};

export const getLeaveTypeById = async (id: Types.ObjectId): Promise<LeaveTypeDocument | null> => {
    return LeaveType.findById(id);
};

export const listAllLeaveTypes = async (): Promise<LeaveTypeDocument[]> => {
    return LeaveType.find();
};
