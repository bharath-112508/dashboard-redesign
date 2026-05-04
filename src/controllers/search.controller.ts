import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/search.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { SearchQuery } from '../validators/search.validator.js';

/**
 * Global-search controller (Step 32; API_Contract §13).
 *
 * Thin pass-through. Auth + role gating happens at the route layer;
 * per-bucket visibility scoping happens inside the service.
 */
export const getSearch = async (req: Request, res: Response): Promise<Response> => {
    if (!req.user?.user_id || !req.user?.role) throw AppError.unauthenticated();

    const data = await service.search(req.query as unknown as SearchQuery, {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role,
    });
    return ok(res, data);
};
