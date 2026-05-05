import { z } from 'zod';

import { AUDIT_ARCHIVE_LIST_DEFAULT_LIMIT, AUDIT_ARCHIVE_LIST_MAX_LIMIT } from '../constants/audit-archive.js';

/**
 * Zod validators for the audit-archive admin surface (Phase 4 Step 39;
 * `/audit-archives/*`).
 *
 * Filters mirror the Step-31 audit-log list: ISO date range
 * (`from_date` / `to_date`) on the `archive_date` field. No actor /
 * action / target filters here because each archive is a daily
 * snapshot — the row-level filters belong on the live `audit_logs`
 * surface, which is what an admin would query for "who did X
 * recently". Forensic queries inside an archive happen by downloading
 * the file and grep'ing locally.
 */

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── GET /audit-archives ────────────────────────────────────────────────

export const listAuditArchivesQuerySchema = z
    .object({
        from_date: isoDateSchema.optional(),
        to_date: isoDateSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(AUDIT_ARCHIVE_LIST_MAX_LIMIT)
            .default(AUDIT_ARCHIVE_LIST_DEFAULT_LIMIT),
    })
    .strict()
    .refine((q) => !q.from_date || !q.to_date || q.from_date <= q.to_date, {
        message: 'from_date must be on or before to_date',
        path: ['to_date'],
    });

export type ListAuditArchivesQuery = z.infer<typeof listAuditArchivesQuerySchema>;

// ─── GET /audit-archives/:id + GET /audit-archives/:id/verify ───────────

export const auditArchiveIdParamSchema = z.object({
    id: objectIdSchema,
});

export type AuditArchiveIdParam = z.infer<typeof auditArchiveIdParamSchema>;
