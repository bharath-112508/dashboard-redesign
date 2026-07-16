import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/timeline.service.js';
import { ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type { ProjectIdParam, TimelineQuery } from '../validators/timeline.validator.js';

/**
 * Timeline / Gantt controller (Phase 4 Step 41).
 *
 * Read-only — no audit, no notifications. The route gate handles
 * authentication + role allowlist; per-project visibility scoping
 * happens inside the service.
 */
export const getTimeline = async (req: Request, res: Response): Promise<Response> => {
    const projectId = new Types.ObjectId((req.params as unknown as ProjectIdParam).project_id);
    const data = await service.buildTimeline(projectId, req.query as unknown as TimelineQuery, projectCallerFrom(req));
    return ok(res, data);
};
