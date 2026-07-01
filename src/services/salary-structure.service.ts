import { Types } from 'mongoose';

import { SalaryStructure, type SalaryStructureDocument } from '../models/salary-structure.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { withTransaction } from '../utils/with-transaction.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { CreateSalaryStructureBody } from '../validators/salary-structure.validator.js';

/**
 * SalaryStructure service — per-user, VERSIONED salary structure rows
 * (Task 5). This is the write/read machinery behind the data source
 * Task 6 (payroll calc), Task 7 (payslip), and Task 8 (hike/promotion
 * letters) all read from.
 *
 * `is_current` semantics: the row with the MAX `effective_from` for a
 * user is the current one. On `createStructure`:
 *   - If the new `effective_from` is >= every existing row's
 *     `effective_from` for that user, the new row becomes current and
 *     every other row for that user is cleared to `is_current: false`.
 *   - Otherwise (a back-dated insert), the new row is created with
 *     `is_current: false` and the existing latest row is left untouched
 *     — it's still the newest, so it stays current.
 *
 * `getCurrentStructure` does NOT trust the `is_current` flag — it
 * re-derives "what applies on date X" directly from `effective_from`,
 * which is the authoritative source of truth. `is_current` is a
 * denormalized convenience for list/detail UI badges only.
 */

export interface SalaryStructureCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

const toPublic = (doc: SalaryStructureDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const todayIso = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

// ─── POST /salary-structures ─────────────────────────────────────────────

export const createStructure = async (
    input: CreateSalaryStructureBody,
    caller: SalaryStructureCaller
): Promise<Record<string, unknown>> => {
    const userOid = new Types.ObjectId(input.user_id);

    const userExists = await User.exists({ _id: userOid });
    if (!userExists) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);

    const created = await withTransaction(async (session) => {
        const existing = await SalaryStructure.find({ user_id: userOid }, null, { session })
            .sort({ effective_from: -1 })
            .limit(1);
        const latestExisting = existing[0] ?? null;

        // The new row is the latest iff no existing row has a strictly
        // greater effective_from — ties go to the new row (it's the one
        // being written "now").
        const isLatest = !latestExisting || input.effective_from >= latestExisting.effective_from;

        if (isLatest) {
            await SalaryStructure.updateMany({ user_id: userOid }, { $set: { is_current: false } }, { session });
        }

        let doc: SalaryStructureDocument;
        try {
            const [createdDoc] = await SalaryStructure.create(
                [
                    {
                        user_id: userOid,
                        effective_from: input.effective_from,
                        earnings: input.earnings,
                        deductions: input.deductions,
                        is_current: isLatest,
                        created_by: caller.id,
                    },
                ],
                { session }
            );
            doc = createdDoc;
        } catch (err: unknown) {
            // The `(user_id, effective_from)` unique index turns a
            // parallel-insert race (two admins posting the same
            // effective_from for the same user) into a deterministic
            // 409 instead of a silent duplicate version row.
            const e = err as { code?: number };
            if (e?.code === 11000) {
                throw AppError.conflict(
                    'A salary structure with this (user_id, effective_from) already exists',
                    ERROR_CODES.DUPLICATE_RESOURCE,
                    { user_id: userOid.toString(), effective_from: input.effective_from }
                );
            }
            throw err;
        }

        if (caller.audit) {
            await recordAudit(caller.audit, {
                action: AUDIT_ACTIONS.SALARY_STRUCTURE_CREATE,
                target: { kind: AUDIT_TARGET_KINDS.SALARY_STRUCTURE, id: doc._id },
                after: toPublic(doc),
                metadata: { user_id: userOid.toString(), effective_from: input.effective_from },
            });
        }

        return doc;
    });

    return toPublic(created);
};

// ─── GET /salary-structures?user_id= ─────────────────────────────────────

export const listStructures = async (query: { user_id: string }): Promise<Record<string, unknown>[]> => {
    const userOid = new Types.ObjectId(query.user_id);
    const rows = await SalaryStructure.find({ user_id: userOid }).sort({ effective_from: -1 });
    return rows.map(toPublic);
};

// ─── GET /salary-structures/:id ──────────────────────────────────────────

export const getStructureById = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const doc = await SalaryStructure.findById(id);
    if (!doc) throw AppError.notFound('Salary structure not found', ERROR_CODES.SALARY_STRUCTURE_NOT_FOUND);
    return toPublic(doc);
};

/**
 * The accessor Task 6/7/8 depend on: the newest salary structure with
 * `effective_from <= onOrBefore` (defaults to today, Asia/Kolkata).
 * Returns the Mongoose document (not a plain object) — callers may need
 * to `.populate()` or read raw subdocs.
 */
export const getCurrentStructure = async (
    userId: Types.ObjectId,
    onOrBefore: string = todayIso()
): Promise<SalaryStructureDocument> => {
    const doc = await SalaryStructure.findOne({ user_id: userId, effective_from: { $lte: onOrBefore } }).sort({
        effective_from: -1,
    });
    if (!doc) {
        throw AppError.notFound('No salary structure on or before this date', ERROR_CODES.PAYROLL_NO_CURRENT_SALARY);
    }
    return doc;
};
