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
appRoutes.use('/project-custom-statuses', customStatusRouter());

export default appRoutes;
