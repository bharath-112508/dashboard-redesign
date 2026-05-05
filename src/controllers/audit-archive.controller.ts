import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/audit-archive.service.js';
import { ok, paginated } from '../utils/api-response.js';
import type { AuditArchiveIdParam, ListAuditArchivesQuery } from '../validators/audit-archive.validator.js';

/**
 * Audit-archive controllers (Phase 4 Step 39).
 *
 * Admin-only, read-only — the cron job is the only writer (no public
 * POST/PATCH/DELETE; the collection is append-only by application
 * convention, mirroring `audit_logs` it descends from).
 *
 * Like the Step-31 audit-log read endpoints, these reads are not
 * audited themselves in v1 (auditing-the-auditor is a Phase-4 follow-
 * up that needs a dedicated read-action verb to avoid recursion).
 */

// ─── GET /audit-archives ────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listArchives(req.query as unknown as ListAuditArchivesQuery);
    return paginated(res, data, meta);
};

// ─── GET /audit-archives/:id ────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const params = req.params as unknown as AuditArchiveIdParam;
    const data = await service.getArchive(new Types.ObjectId(params.id));
    return ok(res, data);
};

// ─── GET /audit-archives/:id/verify ─────────────────────────────────────

export const getVerify = async (req: Request, res: Response): Promise<Response> => {
    const params = req.params as unknown as AuditArchiveIdParam;
    const data = await service.verifyArchive(new Types.ObjectId(params.id));
    return ok(res, data);
};
