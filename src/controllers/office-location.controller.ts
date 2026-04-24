import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/office-location.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    CreateOfficeLocationBody,
    ListOfficeLocationsQuery,
    PatchOfficeLocationBody,
} from '../validators/office-location.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

const parseTargetId = (req: Request): Types.ObjectId => {
    return new Types.ObjectId(req.params.id as string);
};

// ─── POST /office-locations ────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createOfficeLocation(req.body as CreateOfficeLocationBody, callerId(req));
    return created(res, data);
};

// ─── GET /office-locations ────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listOfficeLocations(req.query as unknown as ListOfficeLocationsQuery);
    return paginated(res, data, meta);
};

// ─── GET /office-locations/:id ────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getOfficeLocation(parseTargetId(req));
    return ok(res, data);
};

// ─── PATCH /office-locations/:id ──────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateOfficeLocation(parseTargetId(req), req.body as PatchOfficeLocationBody);
    return ok(res, data);
};

// ─── POST /office-locations/:id/regenerate-qr ─────────────────────────────

export const postRegenerateQr = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.regenerateQrToken(parseTargetId(req));
    return ok(res, data);
};

// ─── DELETE /office-locations/:id ─────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deactivateOfficeLocation(parseTargetId(req));
    return noContent(res);
};
