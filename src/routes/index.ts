import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import settingsRoutes from './settings.routes.js';
import officeLocationRoutes from './office-location.routes.js';
import attendanceRoutes from './attendance.routes.js';

const appRoutes = Router();

appRoutes.use('/auth', authRoutes);
appRoutes.use('/users', userRoutes);
appRoutes.use('/settings', settingsRoutes);
appRoutes.use('/office-locations', officeLocationRoutes);
appRoutes.use('/attendance', attendanceRoutes);

export default appRoutes;
