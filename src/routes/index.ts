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
import searchRoutes from './search.routes.js';
import { projectShareLinksNestedRouter, publicShareLinksRouter, shareLinksRouter } from './share-link.routes.js';

const appRoutes = Router();

appRoutes.use('/auth', authRoutes);
appRoutes.use('/users', userRoutes);
appRoutes.use('/settings', settingsRoutes);
appRoutes.use('/office-locations', officeLocationRoutes);
appRoutes.use('/attendance', attendanceRoutes);
appRoutes.use('/holidays', holidayRoutes);
appRoutes.use('/leave-types', leaveTypeRoutes);
appRoutes.use('/leave-balances', leaveBalanceRoutes);
appRoutes.use('/leaves', leaveRequestRoutes);
appRoutes.use('/comp-off', compOffRoutes);
appRoutes.use('/notifications', notificationRoutes);
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
appRoutes.use('/search', searchRoutes);
appRoutes.use('/projects', projectShareLinksNestedRouter());
appRoutes.use('/share-links', shareLinksRouter());
// Public router mounted last on the same prefix. The auth-required
// `/share-links/:id/revoke` route is matched first by the previous
// mount because Express tries routers in registration order; the
// public router only owns `/resolve/:token`, so there's no overlap.
appRoutes.use('/share-links', publicShareLinksRouter());
appRoutes.use('/project-custom-statuses', customStatusRouter());

export default appRoutes;
