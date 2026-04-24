import { Router } from 'express';

import * as ctrl from '../controllers/project.controller.js';
import * as sprintCtrl from '../controllers/sprint.controller.js';
import * as storyCtrl from '../controllers/story.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PROJECT_READ_ROLES, PROJECT_WRITE_ROLES } from '../constants/project.js';
import { STORY_READ_ROLES, STORY_WRITE_ROLES } from '../constants/story.js';
import {
    createCustomStatusBodySchema,
    createProjectBodySchema,
    listProjectsQuerySchema,
    patchProjectBodySchema,
    projectClientIdParamSchema,
    projectClientsBulkBodySchema,
    projectIdParamSchema,
    projectMemberIdParamSchema,
    projectMembersBulkBodySchema,
} from '../validators/project.validator.js';
import {
    createSprintBodySchema,
    listSprintsQuerySchema,
    projectSprintParamsSchema,
} from '../validators/sprint.validator.js';
import {
    createStoryBodySchema,
    listStoriesQuerySchema,
    projectStoryParamsSchema,
} from '../validators/story.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection: /projects ────────────────────────────────────────────────

router.get(
    '/',
    authorize(...PROJECT_READ_ROLES),
    validate({ query: listProjectsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ body: createProjectBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item: /projects/:id ──────────────────────────────────────────────────

router.get(
    '/:id',
    authorize(...PROJECT_READ_ROLES),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectIdParamSchema, body: patchProjectBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

// ─── Members: /projects/:id/members ──────────────────────────────────────

router.get(
    '/:id/members',
    authorize(...PROJECT_READ_ROLES),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getMembers)
);

router.post(
    '/:id/members',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectIdParamSchema, body: projectMembersBulkBodySchema }),
    asyncHandler(ctrl.postMembers)
);

router.delete(
    '/:id/members/:user_id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectMemberIdParamSchema }),
    asyncHandler(ctrl.deleteMember)
);

// ─── Clients: /projects/:id/clients ──────────────────────────────────────

router.get(
    '/:id/clients',
    authorize(...PROJECT_READ_ROLES),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getClients)
);

router.post(
    '/:id/clients',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectIdParamSchema, body: projectClientsBulkBodySchema }),
    asyncHandler(ctrl.postClients)
);

router.delete(
    '/:id/clients/:user_id',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectClientIdParamSchema }),
    asyncHandler(ctrl.deleteClient)
);

// ─── Custom statuses: /projects/:id/custom-statuses ──────────────────────

router.get(
    '/:id/custom-statuses',
    authorize(...PROJECT_READ_ROLES),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getCustomStatuses)
);

router.post(
    '/:id/custom-statuses',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectIdParamSchema, body: createCustomStatusBodySchema }),
    asyncHandler(ctrl.postCustomStatus)
);

// ─── Sprints (nested create + list) ──────────────────────────────────────
//
// `GET /projects/:project_id/sprints` and `POST /projects/:project_id/sprints`
// live here so they share the project router's `:project_id` namespace; the
// item routes (`GET/PATCH/DELETE /sprints/:id`) live on `sprint.routes.ts`.

router.get(
    '/:project_id/sprints',
    authorize(...PROJECT_READ_ROLES),
    validate({ params: projectSprintParamsSchema, query: listSprintsQuerySchema }),
    asyncHandler(sprintCtrl.getList)
);

router.post(
    '/:project_id/sprints',
    authorize(...PROJECT_WRITE_ROLES),
    validate({ params: projectSprintParamsSchema, body: createSprintBodySchema }),
    asyncHandler(sprintCtrl.postCreate)
);

// ─── Stories (nested create + list) ──────────────────────────────────────
//
// Item routes (`GET/PATCH/DELETE /stories/:id`, `POST /stories/:id/reorder`,
// `GET /stories/:id/tasks`) live on `story.routes.ts` so they don't share
// the project router's `:project_id` prefix.

router.get(
    '/:project_id/stories',
    authorize(...STORY_READ_ROLES),
    validate({ params: projectStoryParamsSchema, query: listStoriesQuerySchema }),
    asyncHandler(storyCtrl.getList)
);

router.post(
    '/:project_id/stories',
    authorize(...STORY_WRITE_ROLES),
    validate({ params: projectStoryParamsSchema, body: createStoryBodySchema }),
    asyncHandler(storyCtrl.postCreate)
);

export default router;
