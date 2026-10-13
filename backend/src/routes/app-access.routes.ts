import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { getAppAccess, setAppAccess } from '../services/app-access.service.js';

/**
 * Redesign: the app's Roles & permissions grid and developer types (display
 * only). Every signed-in person reads it (developer types fill the user
 * form); changing it needs the role-write permission (admins).
 */
const APP_ROLES = ['super', 'admin', 'pm', 'dev', 'devops', 'cadmin', 'cuser'] as const;
const permIds = z.array(z.string().trim().min(1).max(40)).max(50);
const bodySchema = z
    .object({
        perms: z.object(Object.fromEntries(APP_ROLES.map((r) => [r, permIds.optional()]))).strict().optional(),
        dev_types: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    })
    .strict();

const router = Router();
router.use(authenticate);
router.get('/', asyncHandler(async (_req: Request, res: Response) => ok(res, await getAppAccess())));
router.put(
    '/',
    requirePermission(PERMISSIONS.ROLE_WRITE),
    validate({ body: bodySchema }),
    asyncHandler(async (req: Request, res: Response) =>
        ok(res, await setAppAccess(req.body, { ...projectCallerFrom(req), audit: buildAuditContext(req) }))
    )
);
export default router;
