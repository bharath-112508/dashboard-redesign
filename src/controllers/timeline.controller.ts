import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/timeline.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { ProjectIdParam, TimelineQuery } from '../validators/timeline.validator.js';

/**
 * Timeline / Gantt controller (Phase 4 Step 41).
 *
 * Read-only — no audit, no notifications. The route gate handles
 * authentication + role allowlist; per-project visibility scoping
 * happens inside the service.
 */
export const getTimeline = async (req: Request, res: Response): Promise<Response> => {
    if (!req.user?.user_id || !req.user?.role) throw AppError.unauthenticated();
    const projectId = new Types.ObjectId((req.params as unknown as ProjectIdParam).project_id);
    const data = await service.buildTimeline(projectId, req.query as unknown as TimelineQuery, {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role,
    });
    return ok(res, data);
};
