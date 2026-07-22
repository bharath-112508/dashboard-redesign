// src/validators/dashboard.validator.ts
import { z } from 'zod';

import { DASHBOARD_RANGE_KEYS } from '../utils/dashboard-range.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';

/** Query schema for GET /dashboard/:scope/analytics (spec §7). */
export const dashboardAnalyticsQuerySchema = z.object({
    range: z.enum(DASHBOARD_RANGE_KEYS).default('month'),
});
export type DashboardAnalyticsQuery = z.infer<typeof dashboardAnalyticsQuerySchema>;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Query schema for GET /dashboard/:scope/overview (custom-range aware). */
export const dashboardOverviewQuerySchema = z
    .object({ from: ymd.optional(), to: ymd.optional() })
    .transform((q) => {
        const today = dayjs().tz(DEFAULT_TIMEZONE);
        const from = q.from ?? today.startOf('month').format(DATE_FORMAT);
        const to = q.to ?? today.format(DATE_FORMAT);
        return { from, to };
    })
    .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['from'] })
    .refine((q) => dayjs(q.to).diff(dayjs(q.from), 'day') <= 366, {
        message: 'Range cannot exceed 366 days',
        path: ['to'],
    });
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;
