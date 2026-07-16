import { Router } from 'express';

import * as ctrl from '../controllers/project.controller.js';
import * as sprintCtrl from '../controllers/sprint.controller.js';
import * as storyCtrl from '../controllers/story.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createCustomStatusBodySchema,
    createProjectBodySchema,
    listProjectsQuerySchema,
    patchDefaultStatusOrdersBodySchema,
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
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ query: listProjectsQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.PROJECT_WRITE),
    validate({ body: createProjectBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item: /projects/:id ──────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.PROJECT_WRITE),
    validate({ params: projectIdParamSchema, body: patchProjectBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    // G1 — `PROJECT_ARCHIVE` is the granular permission for delete /
    // archive (Team Lead holds it; non-archive write actions use
    // `PROJECT_WRITE`). Using `PROJECT_WRITE` here would let any
    // role with project-write also delete projects, contradicting
    // the role-bundle intent.
    requirePermission(PERMISSIONS.PROJECT_ARCHIVE),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

// ─── Members: /projects/:id/members ──────────────────────────────────────

router.get(
    '/:id/members',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getMembers)
);

router.post(
    '/:id/members',
    // G1 — granular member-roster permission. Both Manager and
    // Team Lead hold this; future custom roles can grant member
    // management without granting `PROJECT_WRITE`.
    requirePermission(PERMISSIONS.PROJECT_MEMBERS_WRITE),
    validate({ params: projectIdParamSchema, body: projectMembersBulkBodySchema }),
    asyncHandler(ctrl.postMembers)
);

router.delete(
    '/:id/members/:user_id',
    requirePermission(PERMISSIONS.PROJECT_MEMBERS_WRITE),
    validate({ params: projectMemberIdParamSchema }),
    asyncHandler(ctrl.deleteMember)
);

// ─── Clients: /projects/:id/clients ──────────────────────────────────────

router.get(
    '/:id/clients',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getClients)
);

router.post(
    '/:id/clients',
    // G1 — granular client-roster permission. Manager holds it,
    // Team Lead does NOT (per role-bundle catalog). Pre-G1 the gate
    // was `PROJECT_WRITE`, which Team Lead also held — so Team Lead
    // could mutate the client roster despite the bundle's intent.
    requirePermission(PERMISSIONS.PROJECT_REPRESENTATIVES_WRITE),
    validate({ params: projectIdParamSchema, body: projectClientsBulkBodySchema }),
    asyncHandler(ctrl.postClients)
);

router.delete(
    '/:id/clients/:user_id',
    requirePermission(PERMISSIONS.PROJECT_REPRESENTATIVES_WRITE),
    validate({ params: projectClientIdParamSchema }),
    asyncHandler(ctrl.deleteClient)
);

// ─── Custom statuses: /projects/:id/custom-statuses ──────────────────────

router.get(
    '/:id/custom-statuses',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectIdParamSchema }),
    asyncHandler(ctrl.getCustomStatuses)
);

router.post(
    '/:id/custom-statuses',
    requirePermission(PERMISSIONS.PROJECT_WRITE),
    validate({ params: projectIdParamSchema, body: createCustomStatusBodySchema }),
    asyncHandler(ctrl.postCustomStatus)
);

// ─── Default-status ordering: /projects/:id/default-status-orders ────────
// Reorder the four built-in status columns (`to_do` / `in_progress` /
// `review` / `done`) for this project. Admins / managers can interleave
// defaults with custom columns on the board.

router.patch(
    '/:id/default-status-orders',
    requirePermission(PERMISSIONS.PROJECT_WRITE),
    validate({ params: projectIdParamSchema, body: patchDefaultStatusOrdersBodySchema }),
    asyncHandler(ctrl.patchDefaultStatusOrders)
);

// ─── Sprints (nested create + list) ──────────────────────────────────────
//
// `GET /projects/:project_id/sprints` and `POST /projects/:project_id/sprints`
// live here so they share the project router's `:project_id` namespace; the
// item routes (`GET/PATCH/DELETE /sprints/:id`) live on `sprint.routes.ts`.

router.get(
    '/:project_id/sprints',
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectSprintParamsSchema, query: listSprintsQuerySchema }),
    asyncHandler(sprintCtrl.getList)
);

router.post(
    '/:project_id/sprints',
    requirePermission(PERMISSIONS.SPRINT_WRITE),
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
    requirePermission(PERMISSIONS.PROJECT_READ),
    validate({ params: projectStoryParamsSchema, query: listStoriesQuerySchema }),
    asyncHandler(storyCtrl.getList)
);

router.post(
    '/:project_id/stories',
    requirePermission(PERMISSIONS.STORY_WRITE),
    validate({ params: projectStoryParamsSchema, body: createStoryBodySchema }),
    asyncHandler(storyCtrl.postCreate)
);

export default router;
