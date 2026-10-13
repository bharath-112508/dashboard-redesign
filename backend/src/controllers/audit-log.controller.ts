import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/audit-log.service.js';
import { ok, paginated } from '../utils/api-response.js';
import type { AuditLogIdParam, ListAuditLogsQuery } from '../validators/audit-log.validator.js';

/**
 * Audit-log read controllers (Step 31; API_Contract §12).
 *
 * Admin-only, read-only. The service does no row-level filtering (the
 * RBAC gate is the route's `requirePermission(audit_log.read)`); every
 * authenticated admin can see every row. We deliberately do NOT audit
 * these reads in v1 — auditing-the-auditor is a Phase-4 concern (would
 * also need a dedicated read action verb to avoid recursion).
 */

// ─── GET /audit-logs ─────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listAuditLogs(req.query as unknown as ListAuditLogsQuery);
    return paginated(res, data, meta);
};

// ─── GET /audit-logs/:id ─────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const params = req.params as unknown as AuditLogIdParam;
    const data = await service.getAuditLog(new Types.ObjectId(params.id));
    return ok(res, data);
};
