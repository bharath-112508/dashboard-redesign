import { describe, expect, it } from 'vitest';

import { toTabularUtilization } from './tabular.js';
import type { UtilizationReportResult } from '../report.service.js';

/**
 * `toTabularUtilization` flattens the per-user report into one row per
 * (user, project) so the export carries the same per-project breakdown the
 * UI shows in its expandable accordion.
 */
describe('toTabularUtilization', () => {
    const base: UtilizationReportResult = {
        from_date: '2026-07-01',
        to_date: '2026-07-31',
        expected_per_user_minutes: 9600, // 160h
        billable: 'all',
        rows: [
            {
                user: { id: 'u1', full_name: 'Anna', role: 'employee' },
                logged_billable_minutes: 1500,
                logged_non_billable_minutes: 300,
                logged_total_minutes: 1800,
                expected_minutes: 9600,
                utilization_pct: 18.75,
                projects: [
                    {
                        project: { id: 'p1', name: 'Apollo' },
                        billable_minutes: 1200,
                        non_billable_minutes: 0,
                        total_minutes: 1200,
                        share_pct: 66.67,
                    },
                    {
                        project: null, // Unassigned bucket
                        billable_minutes: 300,
                        non_billable_minutes: 300,
                        total_minutes: 600,
                        share_pct: 33.33,
                    },
                ],
            },
            {
                user: { id: 'u2', full_name: 'Bob', role: 'manager' },
                logged_billable_minutes: 0,
                logged_non_billable_minutes: 0,
                logged_total_minutes: 0,
                expected_minutes: 9600,
                utilization_pct: 0,
                projects: [], // no logged time
            },
        ],
    };

    it('emits a Project column plus % of time', () => {
        const out = toTabularUtilization(base);
        const keys = out.columns.map((c) => c.key);
        expect(keys).toContain('project');
        expect(keys).toContain('total_hours');
        expect(keys).toContain('share_pct');
        expect(out.columns.find((c) => c.key === 'share_pct')?.label).toBe('% of time');
    });

    it('produces one row per (user, project); null project → "Unassigned"', () => {
        const out = toTabularUtilization(base);
        // Anna has 2 project rows, Bob has 1 fallback row → 3 total.
        expect(out.rows).toHaveLength(3);

        const anna = out.rows.filter((r) => r.user === 'Anna');
        expect(anna.map((r) => r.project)).toEqual(['Apollo', 'Unassigned']);
        // Hours are decimal-hour numbers; Apollo = 1200 min = 20h.
        expect(anna[0].total_hours).toBe(20);
        expect(anna[0].share_pct).toBe(66.67);
        // User-level fields repeat on each of the user's rows.
        expect(anna[0].utilization_pct).toBe(18.75);
        expect(anna[1].utilization_pct).toBe(18.75);
    });

    it('gives a user with no logged time a single "—" row', () => {
        const out = toTabularUtilization(base);
        const bob = out.rows.filter((r) => r.user === 'Bob');
        expect(bob).toHaveLength(1);
        expect(bob[0].project).toBe('—');
        expect(bob[0].total_hours).toBe(0);
        expect(bob[0].utilization_pct).toBe(0);
    });
});
