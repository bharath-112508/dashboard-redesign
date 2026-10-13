import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/slack-settings.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { PatchSlackSettingsBody, TestMessageBody } from '../validators/slack-settings.validator.js';

const callerOf = (req: Request): service.SlackSettingsCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

// ─── GET /settings/slack ─────────────────────────────────────────────────

export const getSlack = async (_req: Request, res: Response): Promise<Response> => {
    const data = await service.getSlackSettings();
    return ok(res, data);
};

// ─── PATCH /settings/slack ───────────────────────────────────────────────

export const patchSlack = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchSlackSettings(req.body as PatchSlackSettingsBody, callerOf(req));
    return ok(res, data);
};

// ─── POST /settings/slack/test-message ───────────────────────────────────

export const postTestMessage = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.sendTestMessage(req.body as TestMessageBody, callerOf(req));
    return ok(res, data);
};
