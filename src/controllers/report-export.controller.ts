import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import * as service from '../services/report-export.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { parseExportBody } from '../validators/report-export.validator.js';
import type { ExportRequestPath, ExportIdPath } from '../validators/report-export.validator.js';

/**
 * Report-export controllers (Step 30).
 *
 * Two endpoints:
 *  - `POST /reports/:name/export` — enqueues a job; returns 202 + the row id.
 *  - `GET /reports/exports/:id`   — owner-scoped status poll.
 *
 * Path validation is handled by the `validate({params})` middleware at the
 * route layer; both controllers receive already-coerced `req.params`.
 *
 * The POST body is parsed here (not via `validate({body})`) because the
 * filter schema is **dispatched on `:name`** — the validator middleware
 * only supports static schemas. We catch the ZodError locally and convert
 * to `AppError.validation` so the global handler returns the canonical
 * 400 VALIDATION_ERROR shape (the global handler otherwise treats raw
 * ZodErrors as 500 INTERNAL_ERROR — only the validate middleware does
 * the conversion).
 */

const callerOf = (req: Request): service.ExportCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const zodErrorToValidation = (err: z.ZodError): AppError => {
    const details = {
        errors: err.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
        })),
    };
    return AppError.validation('Validation failed', details);
};

// ─── POST /reports/:name/export ──────────────────────────────────────────

export const postExport = async (req: Request, res: Response): Promise<Response> => {
    const { name } = req.params as unknown as ExportRequestPath;

    let body;
    try {
        body = parseExportBody(name, req.body);
    } catch (err) {
        if (err instanceof z.ZodError) throw zodErrorToValidation(err);
        throw err;
    }

    const result = await service.enqueueExport(
        { name, format: body.format, filters: body.filters as Record<string, unknown> },
        callerOf(req)
    );

    // 202 Accepted per API_Contract §10.3 — the row is created but the
    // file isn't ready yet; the FE polls `GET /reports/exports/:id`.
    return res.status(StatusCodes.ACCEPTED).json({ data: result });
};

// ─── GET /reports/exports/:id ────────────────────────────────────────────

export const getExportStatus = async (req: Request, res: Response): Promise<Response> => {
    const { id } = req.params as unknown as ExportIdPath;
    const data = await service.getExport(new Types.ObjectId(id), callerOf(req));
    return ok(res, data);
};
