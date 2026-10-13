import { Types } from 'mongoose';

import { OfficeLocation, type OfficeLocationDocument } from '../models/office-location.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { QR_TOKEN_REGENERATION_RETRY_LIMIT } from '../constants/office-location.js';
import { generateQrToken, renderCheckInQrDataUrl } from '../utils/office-location-qr.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateOfficeLocationBody,
    ListOfficeLocationsQuery,
    PatchOfficeLocationBody,
} from '../validators/office-location.validator.js';

type Filter = Record<string, unknown>;

/**
 * Office locations service (API_Contract §4.2).
 *
 *  - QR token is server-generated (24 random bytes → base64url) and unique at
 *    the DB layer. We retry up to N times on E11000 in the (vanishingly
 *    unlikely) event of a collision; anything beyond that is a programming
 *    error and surfaces as 500.
 *  - DELETE is a *soft* delete — sets `is_active = false` so historic
 *    `attendance_records.check_in.location_id` references stay resolvable.
 *  - PATCH can re-activate by sending `{ is_active: true }`.
 *  - `qr_code_image_url` will be the eventual Azure Blob URL (Phase 1 Step 22 /
 *    Phase 2 Step 21). Until then it stays `null` and we ship a freshly-rendered
 *    `qr_data_url` (data: URL) on every read instead.
 */

// ─── Serialisation ────────────────────────────────────────────────────────

const toPublic = async (doc: OfficeLocationDocument): Promise<Record<string, unknown>> => {
    const json = doc.toJSON() as Record<string, unknown>;
    json.qr_data_url = await renderCheckInQrDataUrl(doc.qr_code_token);
    return json;
};

const toPublicMany = async (docs: OfficeLocationDocument[]): Promise<Record<string, unknown>[]> => {
    return Promise.all(docs.map(toPublic));
};

/**
 * I1 — minimal projection for audit before/after snapshots. We deliberately
 * strip:
 *  - `qr_code_token` — it's a secret check-in token; landing it in the
 *    audit log would let anyone with audit-read access bypass geofence
 *    enforcement.
 *  - `qr_data_url` — a base64 PNG that would blow past the per-snapshot
 *    byte cap (`AUDIT_SNAPSHOT_BYTES_MAX = 16 KiB`) on every row, causing
 *    every office-location audit row to drop both snapshots silently.
 * The remaining fields (`name`, `address`, `is_active`, timestamps) are
 * what an operator actually needs to see "who changed what" later.
 */
const toAuditSnapshot = (doc: OfficeLocationDocument): Record<string, unknown> => ({
    id: doc._id.toString(),
    name: doc.name,
    address: doc.address,
    is_active: doc.is_active,
});

// ─── Internal: create with E11000 retry on the unique qr_code_token ──────

const insertWithUniqueToken = async (
    base: Pick<OfficeLocationDocument, 'name' | 'address' | 'created_by'>
): Promise<OfficeLocationDocument> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < QR_TOKEN_REGENERATION_RETRY_LIMIT; attempt++) {
        try {
            return await OfficeLocation.create({
                ...base,
                qr_code_token: generateQrToken(),
                qr_code_image_url: null,
                is_active: true,
            });
        } catch (err: unknown) {
            // Only retry on the qr_code_token uniqueness collision; anything else
            // (e.g. validation, network) re-throws immediately.
            if (
                err &&
                typeof err === 'object' &&
                'code' in err &&
                (err as { code: number }).code === 11000 &&
                'keyPattern' in err &&
                (err as { keyPattern?: Record<string, unknown> }).keyPattern?.qr_code_token
            ) {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw AppError.internal(
        `Failed to allocate a unique QR token after ${QR_TOKEN_REGENERATION_RETRY_LIMIT} attempts: ${String(lastErr)}`
    );
};

// ─── POST /office-locations ──────────────────────────────────────────────

export const createOfficeLocation = async (
    input: CreateOfficeLocationBody,
    created_by: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const created = await insertWithUniqueToken({
        name: input.name,
        address: input.address,
        created_by,
    });
    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.OFFICE_LOCATION_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.OFFICE_LOCATION, id: created._id },
            after: toAuditSnapshot(created),
        });
    }
    return toPublic(created);
};

// ─── GET /office-locations ───────────────────────────────────────────────

export const listOfficeLocations = async (
    query: ListOfficeLocationsQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (query.is_active !== undefined) filter.is_active = query.is_active;
    // BUG-002 — hide deleted (is_active=false) rows by default; opt-in via
    // `show_deleted=true`. An explicit `is_active=...` wins (e.g. an admin
    // listing only the deleted bucket).
    else if (!query.show_deleted) filter.is_active = true;
    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ name: { $regex: safe, $options: 'i' } }, { address: { $regex: safe, $options: 'i' } }];
    }

    const skip = (query.page - 1) * query.limit;

    const [rows, total] = await Promise.all([
        OfficeLocation.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        OfficeLocation.countDocuments(filter),
    ]);

    return {
        data: await toPublicMany(rows),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /office-locations/:id ──────────────────────────────────────────

export const getOfficeLocation = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const doc = await OfficeLocation.findById(id);
    if (!doc) {
        throw AppError.notFound('Office location not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    return toPublic(doc);
};

// ─── PATCH /office-locations/:id ────────────────────────────────────────

export const updateOfficeLocation = async (
    id: Types.ObjectId,
    patch: PatchOfficeLocationBody,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const doc = await OfficeLocation.findById(id);
    if (!doc) {
        throw AppError.notFound('Office location not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    const before = toAuditSnapshot(doc);

    if (patch.name !== undefined) doc.name = patch.name;
    if (patch.address !== undefined) doc.address = patch.address;
    if (patch.is_active !== undefined) doc.is_active = patch.is_active;

    await doc.save();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.OFFICE_LOCATION_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.OFFICE_LOCATION, id: doc._id },
            before,
            after: toAuditSnapshot(doc),
        });
    }

    return toPublic(doc);
};

// ─── DELETE /office-locations/:id (soft) ────────────────────────────────

export const deactivateOfficeLocation = async (id: Types.ObjectId, audit?: AuditContext): Promise<void> => {
    const result = await OfficeLocation.findByIdAndUpdate(id, { $set: { is_active: false } }, { new: true });
    if (!result) {
        throw AppError.notFound('Office location not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.OFFICE_LOCATION_DEACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.OFFICE_LOCATION, id: result._id },
            before: { is_active: true },
            after: { is_active: false },
        });
    }
};

// ─── POST /office-locations/:id/regenerate-qr ───────────────────────────

export const regenerateQrToken = async (id: Types.ObjectId, audit?: AuditContext): Promise<Record<string, unknown>> => {
    const doc = await OfficeLocation.findById(id);
    if (!doc) {
        throw AppError.notFound('Office location not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < QR_TOKEN_REGENERATION_RETRY_LIMIT; attempt++) {
        try {
            doc.qr_code_token = generateQrToken();
            // The future Blob image is stale the moment the token rotates; null
            // it out so a downstream reader doesn't accidentally serve a QR
            // pointing at the old token.
            doc.qr_code_image_url = null;
            await doc.save();
            if (audit) {
                // I1 — record the rotation event WITHOUT echoing the new
                // token. The token is a check-in secret; landing it in
                // the audit log would let anyone with audit-read defeat
                // the rotation.
                await recordAudit(audit, {
                    action: AUDIT_ACTIONS.OFFICE_LOCATION_QR_ROTATE,
                    target: { kind: AUDIT_TARGET_KINDS.OFFICE_LOCATION, id: doc._id },
                });
            }
            return toPublic(doc);
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw AppError.internal(
        `Failed to allocate a unique QR token after ${QR_TOKEN_REGENERATION_RETRY_LIMIT} attempts: ${String(lastErr)}`
    );
};
