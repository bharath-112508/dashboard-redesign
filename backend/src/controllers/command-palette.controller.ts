import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/command-palette.service.js';
import { ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type { CommandPaletteQuery } from '../validators/command-palette.validator.js';

/**
 * Command-palette controller — Step 49.
 *
 * Single endpoint: `GET /command-palette[?q=...]`. The route is
 * gated on `authenticate` only — every user gets a personalised
 * actions catalog (filtered inside the service) plus search-side
 * items when the query is specific enough.
 */

export const getCommandPalette = async (req: Request, res: Response): Promise<Response> => {
    if (!req.user) throw AppError.unauthenticated();
    // Pass `role` + `role_keys` alongside `permissions` so the
    // service can recognise legacy admin tokens and apply the same
    // wildcard fast-path `requirePermission` does.
    const data = await service.getCommandPalette(req.query as unknown as CommandPaletteQuery, {
        id: new Types.ObjectId(req.user.user_id),
        permissions: req.user.permissions ?? [],
        role: req.user.role,
        role_keys: req.user.role_keys,
    });
    return ok(res, data);
};
