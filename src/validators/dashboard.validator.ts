// src/validators/dashboard.validator.ts
import { z } from 'zod';

import { DASHBOARD_RANGE_KEYS } from '../utils/dashboard-range.js';

/** Query schema for GET /dashboard/:scope/analytics (spec §7). */
export const dashboardAnalyticsQuerySchema = z.object({
    range: z.enum(DASHBOARD_RANGE_KEYS).default('month'),
});
export type DashboardAnalyticsQuery = z.infer<typeof dashboardAnalyticsQuerySchema>;
