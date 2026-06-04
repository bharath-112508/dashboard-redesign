import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import settingsRoutes from './settings.routes.js';
import officeLocationRoutes from './office-location.routes.js';
import attendanceRoutes from './attendance.routes.js';
import holidayRoutes from './holiday.routes.js';
import leaveTypeRoutes from './leave-type.routes.js';
import leaveBalanceRoutes from './leave-balance.routes.js';
import leaveRequestRoutes from './leave-request.routes.js';
import compOffRoutes from './comp-off.routes.js';
import notificationRoutes from './notification.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import projectRoutes from './project.routes.js';
import sprintRoutes, { customStatusRouter } from './sprint.routes.js';
import storyRoutes from './story.routes.js';
import taskRoutes from './task.routes.js';
import { commentsRouter, taskCommentsNestedRouter } from './task-comment.routes.js';
import { taskActivityRouter } from './task-activity.routes.js';
import { attachmentsRouter, taskAttachmentsNestedRouter } from './task-attachment.routes.js';
import timesheetRoutes from './timesheet.routes.js';
import billingRateRoutes from './billing-rate.routes.js';
import reportRoutes from './report.routes.js';
import auditLogRoutes from './audit-log.routes.js';
import auditArchiveRoutes from './audit-archive.routes.js';
import searchRoutes from './search.routes.js';
import taskTemplateRoutes, { projectNestedRouter as taskTemplateNestedRouter } from './task-template.routes.js';
import { projectTimelineNestedRouter } from './timeline.routes.js';
import reportPresetRoutes from './report-preset.routes.js';
import reportSubscriptionRoutes from './report-subscription.routes.js';
import { projectShareLinksNestedRouter, publicShareLinksRouter, shareLinksRouter } from './share-link.routes.js';
import roleRoutes, { userRolesAssignRouter } from './role.routes.js';
import commandPaletteRoutes from './command-palette.routes.js';
import pushRoutes from './push.routes.js';

const appRoutes = Router();

appRoutes.use('/auth', authRoutes);
appRoutes.use('/users', userRoutes);
// Step 47 Phase C — `PATCH /users/:user_id/roles` lives next to /users
// (the resource hierarchy is users → roles), separate from the /roles
// CRUD surface. Mounted before more-specific user routes wouldn't
// shadow it; `userRoutes` itself doesn't claim `/:user_id/roles`.
appRoutes.use('/users', userRolesAssignRouter());
appRoutes.use('/roles', roleRoutes);
appRoutes.use('/settings', settingsRoutes);
appRoutes.use('/office-locations', officeLocationRoutes);
appRoutes.use('/attendance', attendanceRoutes);
appRoutes.use('/holidays', holidayRoutes);
appRoutes.use('/leave-types', leaveTypeRoutes);
appRoutes.use('/leave-balances', leaveBalanceRoutes);
appRoutes.use('/leaves', leaveRequestRoutes);
appRoutes.use('/comp-off', compOffRoutes);
appRoutes.use('/notifications', notificationRoutes);
appRoutes.use('/push', pushRoutes);
appRoutes.use('/dashboard', dashboardRoutes);
appRoutes.use('/projects', projectRoutes);
appRoutes.use('/sprints', sprintRoutes);
appRoutes.use('/stories', storyRoutes);
appRoutes.use('/tasks', taskRoutes);
appRoutes.use('/tasks', taskCommentsNestedRouter());
appRoutes.use('/tasks', taskActivityRouter());
appRoutes.use('/tasks', taskAttachmentsNestedRouter());
appRoutes.use('/comments', commentsRouter());
appRoutes.use('/attachments', attachmentsRouter());
appRoutes.use('/timesheets', timesheetRoutes);
appRoutes.use('/billing-rates', billingRateRoutes);
appRoutes.use('/reports', reportRoutes);
appRoutes.use('/audit-logs', auditLogRoutes);
appRoutes.use('/audit-archives', auditArchiveRoutes);
appRoutes.use('/search', searchRoutes);
appRoutes.use('/projects/:project_id/task-templates', taskTemplateNestedRouter());
appRoutes.use('/task-templates', taskTemplateRoutes);
appRoutes.use('/projects/:project_id/timeline', projectTimelineNestedRouter());
appRoutes.use('/report-presets', reportPresetRoutes);
appRoutes.use('/report-subscriptions', reportSubscriptionRoutes);
appRoutes.use('/projects', projectShareLinksNestedRouter());
appRoutes.use('/share-links', shareLinksRouter());
// Public router mounted last on the same prefix. The auth-required
// `/share-links/:id/revoke` route is matched first by the previous
// mount because Express tries routers in registration order; the
// public router only owns `/resolve/:token`, so there's no overlap.
appRoutes.use('/share-links', publicShareLinksRouter());
appRoutes.use('/project-custom-statuses', customStatusRouter());
// Step 49 — Command-palette / Cmd-K shortcuts. Reads only; the
// underlying catalog is a static constant filtered per caller's
// permissions inside the service.
appRoutes.use('/command-palette', commandPaletteRoutes);

export default appRoutes;
