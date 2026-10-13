import { z } from 'zod';

import { AUDIT_LOG_LIST_DEFAULT_LIMIT, AUDIT_LOG_LIST_MAX_LIMIT } from '../constants/audit.js';

/**
 * Zod validators for the audit-log read endpoints (Step 31; API_Contract §12).
 *
 * `GET /audit-logs` is admin-only and supports filter combinations the
 * Step-12 model already indexes — the four composite indexes on
 * `audit_logs` cover every filter combo the FE can build.
 *
 * `action` is a free-form string (not narrowed to the `AUDIT_ACTIONS`
 * enum) because:
 *   1. Older audit rows may carry actions that have since been renamed
 *      (the schema accepts any string up to `AUDIT_ACTION_MAX`).
 *   2. A locked enum here would make this validator a contract surface
 *      that has to be updated in lockstep with every new audit verb,
 *      which is friction the FE doesn't actually want.
 * Same logic for `target_kind`. Length caps mirror the model.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// ─── GET /audit-logs ────────────────────────────────────────────────────

export const listAuditLogsQuerySchema = z
    .object({
        actor_id: objectIdSchema.optional(),
        action: z.string().min(1).max(80).optional(),
        target_kind: z.string().min(1).max(80).optional(),
        target_id: objectIdSchema.optional(),
        from_date: isoDateSchema.optional(),
        to_date: isoDateSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(AUDIT_LOG_LIST_MAX_LIMIT).default(AUDIT_LOG_LIST_DEFAULT_LIMIT),
    })
    .strict()
    .refine((q) => !q.from_date || !q.to_date || q.from_date <= q.to_date, {
        message: 'from_date must be on or before to_date',
        path: ['to_date'],
    })
    .refine((q) => !q.target_id || q.target_kind, {
        message: 'target_kind is required when target_id is provided',
        path: ['target_kind'],
    });

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

// ─── GET /audit-logs/:id ────────────────────────────────────────────────

export const auditLogIdParamSchema = z.object({
    id: objectIdSchema,
});

export type AuditLogIdParam = z.infer<typeof auditLogIdParamSchema>;
