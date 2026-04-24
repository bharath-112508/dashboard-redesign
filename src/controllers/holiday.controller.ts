import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/holiday.service.js';
import { created, noContent, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    BulkCreateHolidaysBody,
    CreateHolidayBody,
    ListHolidaysQuery,
    PatchHolidayBody,
} from '../validators/holiday.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

const parseTargetId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

// ─── POST /holidays ────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createHoliday(req.body as CreateHolidayBody, callerId(req));
    return created(res, data);
};

// ─── POST /holidays/bulk ──────────────────────────────────────────────────

export const postBulk = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.bulkCreateHolidays(req.body as BulkCreateHolidaysBody, callerId(req));
    // 201 even when some rows skipped — the new rows were created. The
    // payload tells the caller exactly which ones got in and which didn't.
    return created(res, result);
};

// ─── GET /holidays ─────────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listHolidays(req.query as unknown as ListHolidaysQuery);
    return ok(res, data, meta);
};

// ─── PATCH /holidays/:id ──────────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateHoliday(parseTargetId(req), req.body as PatchHolidayBody);
    return ok(res, data);
};

// ─── DELETE /holidays/:id ─────────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteHoliday(parseTargetId(req));
    return noContent(res);
};
