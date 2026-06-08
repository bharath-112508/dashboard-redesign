import { Types } from 'mongoose';
import { z } from 'zod';

import { ReportPreset, type ReportPresetDocument } from '../models/report-preset.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { REPORT_PRESET_PER_USER_CAP } from '../constants/report-preset.js';
import { type ReportExportName } from '../constants/export.js';
import { parsePresetFilters } from '../validators/report-preset.validator.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateReportPresetBody,
    ListReportPresetsQuery,
    PatchReportPresetBody,
} from '../validators/report-preset.validator.js';

/**
 * Report-preset service (Phase 4 Step 42).
 *
 * Owner-scoped CRUD. Every read/write filters by `user_id =
 * caller.id` — admins reading another admin's presets get
 * `REPORT_PRESET_NOT_FOUND` (anti-enumeration), exactly the same
 * 404-not-403 pattern that notifications + refresh-token sessions
 * use.
 *
 * The service does the per-`report_name` filter validation via
 * `parsePresetFilters`, mirroring Step-30's controller-side dispatch.
 * Centralising it here means both POST and PATCH go through the same
 * code path; the controller stays thin.
 */

// ─── Helpers ───────────────────────────────────────────────────────────

const toPublic = (doc: ReportPresetDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const wrapZodError = (err: unknown): never => {
    if (err instanceof z.ZodError) {
        // Prefix every issue path with `filters.` so the FE sees the
        // exact request-body path (`filters.project_id`) rather than
        // the dispatched-schema-relative path (`project_id`). Without
        // the prefix, two issues from different request fields
        // (`name` vs `filters.name`) would be indistinguishable.
        const details = {
            errors: err.issues.map((issue) => ({
                field: ['filters', ...issue.path].join('.'),
                message: issue.message,
            })),
        };
        throw AppError.validation('Preset filter validation failed', details);
    }
    throw err;
};

const validateFilters = (name: ReportExportName, filters: unknown): Record<string, unknown> => {
    try {
        return parsePresetFilters(name, filters);
    } catch (err) {
        return wrapZodError(err);
    }
};

// ─── Create ────────────────────────────────────────────────────────────

export const createPreset = async (
    body: CreateReportPresetBody,
    callerId: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    // Per-user cap enforcement BEFORE the create attempt. Defence-in-
    // depth: even if a future migration loosens the unique compound
    // index, the cap is still enforced.
    const existingCount = await ReportPreset.countDocuments({ user_id: callerId });
    if (existingCount >= REPORT_PRESET_PER_USER_CAP) {
        throw AppError.unprocessable(
            `Cannot save more than ${REPORT_PRESET_PER_USER_CAP} report presets — delete one first`,
            ERROR_CODES.REPORT_PRESET_LIMIT_EXCEEDED
        );
    }

    const filters = validateFilters(body.report_name, body.filters);

    let doc: ReportPresetDocument;
    try {
        doc = await ReportPreset.create({
            user_id: callerId,
            name: body.name,
            report_name: body.report_name,
            filters,
        });
    } catch (err: unknown) {
        // Unique-index collision on `(user_id, name)` — duplicate name.
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            throw AppError.conflict(
                `A preset named "${body.name}" already exists; pick a different name or update the existing preset`,
                ERROR_CODES.DUPLICATE_RESOURCE
            );
        }
        throw err;
    }

    // H7 — sibling `report-subscription.*` was already audited; preset
    // was the only saved-filter CRUD without a forensic trail.
    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_PRESET_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_PRESET, id: doc._id },
            after: { name: doc.name, report_name: doc.report_name },
            metadata: { user_id: callerId.toString() },
        });
    }
    return toPublic(doc);
};

// ─── List ──────────────────────────────────────────────────────────────

export const listPresets = async (
    query: ListReportPresetsQuery,
    callerId: Types.ObjectId
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = { user_id: callerId };
    if (query.report_name) filter.report_name = query.report_name;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        ReportPreset.find(filter).sort({ name: 1 }).skip(skip).limit(query.limit),
        ReportPreset.countDocuments(filter),
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

// ─── Get ───────────────────────────────────────────────────────────────

export const getPreset = async (id: Types.ObjectId, callerId: Types.ObjectId): Promise<Record<string, unknown>> => {
    const doc = await ReportPreset.findOne({ _id: id, user_id: callerId });
    if (!doc) throw AppError.notFound('Report preset not found', ERROR_CODES.REPORT_PRESET_NOT_FOUND);
    return toPublic(doc);
};

// ─── Patch ─────────────────────────────────────────────────────────────

export const updatePreset = async (
    id: Types.ObjectId,
    body: PatchReportPresetBody,
    callerId: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const doc = await ReportPreset.findOne({ _id: id, user_id: callerId });
    if (!doc) throw AppError.notFound('Report preset not found', ERROR_CODES.REPORT_PRESET_NOT_FOUND);

    // H7 — snapshot before for the audit row.
    const beforeName = doc.name;
    const beforeFilters = doc.filters;

    if (body.name !== undefined) doc.name = body.name;
    if (body.filters !== undefined) {
        // Validate against the EXISTING `report_name` (locked at
        // creation). Operators tweaking only the name don't need to
        // re-resubmit valid filters.
        doc.filters = validateFilters(doc.report_name, body.filters);
    }

    try {
        await doc.save();
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            throw AppError.conflict(
                `A preset named "${doc.name}" already exists; pick a different name`,
                ERROR_CODES.DUPLICATE_RESOURCE
            );
        }
        throw err;
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_PRESET_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_PRESET, id: doc._id },
            before: { name: beforeName, filters: beforeFilters as Record<string, unknown> },
            after: { name: doc.name, filters: doc.filters as Record<string, unknown> },
            metadata: { user_id: callerId.toString(), report_name: doc.report_name },
        });
    }
    return toPublic(doc);
};

// ─── Delete ────────────────────────────────────────────────────────────

export const deletePreset = async (
    id: Types.ObjectId,
    callerId: Types.ObjectId,
    audit?: AuditContext
): Promise<{ deleted: true }> => {
    // H7 — load the row BEFORE deletion so the audit's `before` block
    // can carry the name + report_name. Otherwise the audit row would
    // point at an id with no useful context.
    const doc = await ReportPreset.findOne({ _id: id, user_id: callerId }).select('name report_name');
    const result = await ReportPreset.deleteOne({ _id: id, user_id: callerId });
    if (result.deletedCount === 0) {
        throw AppError.notFound('Report preset not found', ERROR_CODES.REPORT_PRESET_NOT_FOUND);
    }
    if (audit && doc) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_PRESET_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_PRESET, id },
            before: { name: doc.name, report_name: doc.report_name },
            metadata: { user_id: callerId.toString() },
        });
    }
    return { deleted: true };
};
