import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';

const appRoutes = Router();

appRoutes.use('/auth', authRoutes);
appRoutes.use('/users', userRoutes);

export default appRoutes;
