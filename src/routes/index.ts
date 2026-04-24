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

export default appRoutes;
