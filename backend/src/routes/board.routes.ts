import { Router, type Request, type Response } from 'express';
import { authenticate, holdsPermission, requirePermission } from '../middlewares/auth.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ok } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import { loadBoard, loadCompanyDetails } from '../services/board.service.js';

/**
 * Redesign: the board and the companies page in one request each (see
 * board.service.ts), behind the permissions of the per-project routes they replace.
 */
const router = Router();
router.use(authenticate);

// The project routes need project.read and the task list task.read; both are required here.
router.get(
    '/',
    requirePermission(PERMISSIONS.PROJECT_READ),
    requirePermission(PERMISSIONS.TASK_READ),
    asyncHandler(async (req: Request, res: Response) => ok(res, await loadBoard(projectCallerFrom(req))))
);

// Contacts follow GET /companies/:id/representatives: company.read or representative.write.
router.get(
    '/companies',
    requirePermission(PERMISSIONS.PROJECT_READ),
    asyncHandler(async (req: Request, res: Response) =>
        ok(
            res,
            await loadCompanyDetails(
                projectCallerFrom(req),
                holdsPermission(req.user!, PERMISSIONS.COMPANY_READ, PERMISSIONS.REPRESENTATIVE_WRITE)
            )
        )
    )
);

export default router;
