import { Router } from 'express';

import * as ctrl from '../controllers/task-attachment.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    attachmentIdPathSchema,
    finalizeAttachmentBodySchema,
    listAttachmentsQuerySchema,
    taskIdPathSchema,
    uploadUrlBodySchema,
} from '../validators/task-attachment.validator.js';

/**
 * Task-attachment routes (Step 21; API_Contract.md §8.5).
 *
 * Two routers because the resource is split across nested + top-level URLs:
 *   - `/tasks/:task_id/attachments`              (list)
 *   - `/tasks/:task_id/attachments/upload-url`   (mint write SAS)
 *   - `/tasks/:task_id/attachments/finalize`     (record metadata)
 *   - `/attachments/:id/download-url`            (mint read SAS)
 *   - `/attachments/:id`                         (delete)
 *
 * Both share the same role gate; the service handles per-row uploader /
 * admin permissions for delete.
 */

// ─── Nested under /tasks/:task_id/attachments ────────────────────────────

export const taskAttachmentsNestedRouter = (): Router => {
    const router = Router({ mergeParams: true });
    router.use(authenticate);

    router.get(
        '/:task_id/attachments',
        requirePermission(PERMISSIONS.TASK_READ),
        validate({ params: taskIdPathSchema, query: listAttachmentsQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/:task_id/attachments/upload-url',
        requirePermission(PERMISSIONS.TASK_ATTACHMENT_WRITE),
        validate({ params: taskIdPathSchema, body: uploadUrlBodySchema }),
        asyncHandler(ctrl.postUploadUrl)
    );

    router.post(
        '/:task_id/attachments/finalize',
        requirePermission(PERMISSIONS.TASK_ATTACHMENT_WRITE),
        validate({ params: taskIdPathSchema, body: finalizeAttachmentBodySchema }),
        asyncHandler(ctrl.postFinalize)
    );

    return router;
};

// ─── Top-level /attachments/:id ──────────────────────────────────────────

export const attachmentsRouter = (): Router => {
    const router = Router();
    router.use(authenticate);

    router.get(
        '/:id/download-url',
        requirePermission(PERMISSIONS.TASK_READ),
        validate({ params: attachmentIdPathSchema }),
        asyncHandler(ctrl.getDownloadUrl)
    );

    router.delete(
        '/:id',
        requirePermission(PERMISSIONS.TASK_ATTACHMENT_WRITE),
        validate({ params: attachmentIdPathSchema }),
        asyncHandler(ctrl.deleteOne)
    );

    return router;
};
