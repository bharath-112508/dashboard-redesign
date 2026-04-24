import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as settingsService from '../services/settings.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { PatchSettingsBody } from '../validators/settings.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

// ─── GET /settings/public ──────────────────────────────────────────────────
// Unauthenticated — branding only, used by the login page.
export const getPublicSettings = async (_req: Request, res: Response): Promise<Response> => {
    const result = await settingsService.getPublicSettings();
    return ok(res, result);
};

// ─── GET /settings ─────────────────────────────────────────────────────────
// Any authenticated user. Service redacts admin-only sections for non-admins.
export const getSettings = async (req: Request, res: Response): Promise<Response> => {
    if (!req.user) throw AppError.unauthenticated();
    const result = await settingsService.getSettingsForCaller(req.user.role);
    return ok(res, result);
};

// ─── PATCH /settings ───────────────────────────────────────────────────────
// Admin only. Partial deep-merge per section.
export const patchSettings = async (req: Request, res: Response): Promise<Response> => {
    const result = await settingsService.patchSettings(req.body as PatchSettingsBody, callerId(req));
    return ok(res, result);
};
