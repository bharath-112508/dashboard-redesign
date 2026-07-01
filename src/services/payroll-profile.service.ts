import { Types } from 'mongoose';

import { PayrollProfile, type PayrollProfileDocument } from '../models/payroll-profile.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { UpsertPayrollProfileBody, ListPayrollProfilesQuery } from '../validators/payroll-profile.validator.js';

/**
 * PayrollProfile service — per-user store of statutory/bank fields
 * (PAN, UAN, PF, ESI, PRAN, bank details, tax regime). `upsertProfile`
 * is the single write path (create-or-update, keyed by `user_id`);
 * every mutation records an audit row.
 */

export interface PayrollCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

const toPublic = (d: PayrollProfileDocument): Record<string, unknown> => d.toJSON() as Record<string, unknown>;

export const upsertProfile = async (
    userId: Types.ObjectId,
    body: UpsertPayrollProfileBody,
    caller: PayrollCaller
): Promise<Record<string, unknown>> => {
    const userExists = await User.exists({ _id: userId });
    if (!userExists) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);

    const doc = await PayrollProfile.findOneAndUpdate(
        { user_id: userId },
        { $set: { ...body, updated_by: caller.id }, $setOnInsert: { user_id: userId } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.PAYROLL_PROFILE_UPSERT,
            target: { kind: AUDIT_TARGET_KINDS.PAYROLL_PROFILE, id: doc!._id },
            after: toPublic(doc!),
            metadata: { user_id: userId.toString() },
        });
    }
    return toPublic(doc!);
};

export const getProfile = async (userId: Types.ObjectId): Promise<Record<string, unknown>> => {
    const doc = await PayrollProfile.findOne({ user_id: userId });
    if (!doc) throw AppError.notFound('Payroll profile not found', ERROR_CODES.PAYROLL_PROFILE_NOT_FOUND);
    return toPublic(doc);
};

export const listProfiles = async (
    query: ListPayrollProfilesQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        PayrollProfile.find({}).sort({ updated_at: -1 }).skip(skip).limit(query.limit),
        PayrollProfile.countDocuments({}),
    ]);
    return {
        data: rows.map(toPublic),
        meta: { page: query.page, limit: query.limit, total, total_pages: Math.max(1, Math.ceil(total / query.limit)) },
    };
};
