import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { COLLECTIONS } from '../constants/collections.js';
import { AUDIT_ACTION_MAX, AUDIT_TARGET_KIND_MAX, type AuditAction, type AuditActorRole } from '../constants/audit.js';

/**
 * `audit_logs` — Data_Model.md §7.2.
 *
 * Phase-1 contract:
 *   - **Append-only.** No update / delete from app code (the read endpoint at
 *     §12 is Phase-3-only).
 *   - **Retained indefinitely** — no TTL.
 *   - `actor_id` is nullable so system-triggered events (cron, future
 *     scheduled jobs in Step 14) can be recorded without a synthetic user.
 *   - `target_entity.id` is nullable for actions whose subject is a singleton
 *     (e.g. `settings.update` against the system_settings document — we still
 *     record `kind: 'system_settings'` but `id` is `null`).
 *
 * Why the schema differs slightly from BUILD_PROGRESS.md's draft (`target_type`
 * + `target_id` flat fields): Data_Model.md §7.2 is the source of truth and
 * uses `target_entity { kind, id }`. The future read endpoint will filter on
 * `"target_entity.kind"` + `"target_entity.id"` per the dotted-path index.
 *
 * Indexes mirror Data_Model.md §7.2 exactly:
 *   1. `{ created_at: -1 }`                         — global recency
 *   2. `{ actor_id: 1, created_at: -1 }`            — "what did user X do?"
 *   3. `{ target_entity.kind: 1, target_entity.id: 1, created_at: -1 }`
 *                                                    — "history of resource Y"
 *   4. `{ action: 1, created_at: -1 }`              — "all role-changes recently"
 *
 * `_base.ts` adds `updated_at`; we override `timestamps` here to record
 * `created_at` only since audit rows are immutable.
 */

export interface AuditTargetEntity {
    kind: string;
    id: Types.ObjectId | null;
}

export interface AuditLogDocument extends Document {
    _id: Types.ObjectId;
    actor_id: Types.ObjectId | null;
    actor_role: AuditActorRole;
    action: AuditAction | string;
    target_entity: AuditTargetEntity;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
    created_at: Date;
}

const targetEntitySchema = new Schema<AuditTargetEntity>(
    {
        kind: { type: String, required: true, trim: true, maxlength: AUDIT_TARGET_KIND_MAX },
        id: { type: Schema.Types.ObjectId, required: false, default: null },
    },
    { _id: false }
);

const auditLogSchema = new Schema<AuditLogDocument>(
    {
        actor_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: false,
            default: null,
            index: true,
        },
        actor_role: { type: String, required: true, trim: true, maxlength: 32 },
        action: { type: String, required: true, trim: true, maxlength: AUDIT_ACTION_MAX },
        target_entity: { type: targetEntitySchema, required: true },
        before: { type: Schema.Types.Mixed, required: false, default: null },
        after: { type: Schema.Types.Mixed, required: false, default: null },
        metadata: { type: Schema.Types.Mixed, required: false, default: () => ({}) },
    },
    {
        // Audit rows are immutable; record `created_at` only.
        timestamps: { createdAt: 'created_at', updatedAt: false },
        versionKey: false,
        collection: COLLECTIONS.AUDIT_LOGS,
        toJSON: {
            virtuals: true,
            transform: (_doc, ret: Record<string, unknown>) => {
                if (ret._id) {
                    ret.id = String(ret._id);
                    delete ret._id;
                }
                return ret;
            },
        },
        toObject: { virtuals: true },
    }
);

// Composite indexes from Data_Model §7.2.
auditLogSchema.index({ created_at: -1 });
auditLogSchema.index({ actor_id: 1, created_at: -1 });
auditLogSchema.index({ 'target_entity.kind': 1, 'target_entity.id': 1, created_at: -1 });
auditLogSchema.index({ action: 1, created_at: -1 });

export const AuditLog: Model<AuditLogDocument> = model<AuditLogDocument>(COLLECTIONS.AUDIT_LOGS, auditLogSchema);
