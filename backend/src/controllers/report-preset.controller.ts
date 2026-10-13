import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/report-preset.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateReportPresetBody,
    ListReportPresetsQuery,
    PatchReportPresetBody,
    ReportPresetIdParam,
} from '../validators/report-preset.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const idOf = (req: Request): Types.ObjectId => new Types.ObjectId((req.params as unknown as ReportPresetIdParam).id);

// ─── POST /report-presets ────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createPreset(req.body as CreateReportPresetBody, callerId(req), buildAuditContext(req));
    return created(res, data);
};

// ─── GET /report-presets ─────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listPresets(req.query as unknown as ListReportPresetsQuery, callerId(req));
    return paginated(res, data, meta);
};

// ─── GET /report-presets/:id ─────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getPreset(idOf(req), callerId(req));
    return ok(res, data);
};

// ─── PATCH /report-presets/:id ───────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updatePreset(
        idOf(req),
        req.body as PatchReportPresetBody,
        callerId(req),
        buildAuditContext(req)
    );
    return ok(res, data);
};

// ─── DELETE /report-presets/:id ──────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deletePreset(idOf(req), callerId(req), buildAuditContext(req));
    return ok(res, data);
};
