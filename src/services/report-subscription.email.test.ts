import { describe, expect, it } from 'vitest';

import { renderReportSubscriptionEmail } from './report-subscription.email.js';
import type { AttendanceReportResult, BillingReportResult, LeaveReportResult } from './report.service.js';

/**
 * Email-render unit tests (Phase 4 Step 43).
 *
 * Pure function — no mocking required. Verifies:
 *  - Subject carries the subscription name + report title.
 *  - HTML body contains summary block + the first N rows.
 *  - "and N more" hint appears only when row count exceeds the
 *    preview cap.
 *  - HTML escapes user-controlled values (XSS-safe: e.g. a project
 *    name "<script>" should render as plain text).
 *  - Plain-text body always present (for clients that strip HTML).
 *  - Empty-row case renders a placeholder, not a broken table.
 */

const billingFixture = (overrides: Partial<BillingReportResult> = {}): BillingReportResult => ({
    project: { id: 'p1', name: 'Apollo' },
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    rows: [
        {
            user: { id: 'u1', full_name: 'Anna' },
            task: { id: 't1', title: 'Build login' },
            billable_minutes: 600,
            non_billable_minutes: 0,
            hourly_rate: 2500,
            billable_amount: 25000,
        },
    ],
    totals: { billable_minutes: 600, non_billable_minutes: 0, billable_amount: 25000 },
    ...overrides,
});

describe('renderReportSubscriptionEmail', () => {
    it('subject combines subscription name + report title', () => {
        const email = renderReportSubscriptionEmail('billing', billingFixture(), 'Monthly billing — Apollo');
        expect(email.subject).toContain('Monthly billing — Apollo');
        expect(email.subject).toContain('Billing report');
    });

    it('html body contains the summary block + the data row', () => {
        const email = renderReportSubscriptionEmail('billing', billingFixture(), 'Apollo');
        expect(email.html).toContain('Apollo'); // project name in summary
        expect(email.html).toContain('2026-04-01'); // from_date in summary
        expect(email.html).toContain('Anna'); // row data
        expect(email.html).toContain('Build login');
    });

    it('plain-text body is always present (HTML-stripping clients)', () => {
        const email = renderReportSubscriptionEmail('billing', billingFixture(), 'Apollo');
        expect(email.text.length).toBeGreaterThan(0);
        expect(email.text).toContain('Billing report');
        expect(email.text).toContain('Project: Apollo');
    });

    it('escapes HTML in user-controlled values (XSS guard)', () => {
        const dangerousFixture = billingFixture({
            project: { id: 'p1', name: '<script>alert(1)</script>' },
        });
        const email = renderReportSubscriptionEmail('billing', dangerousFixture, 'Apollo');
        // The literal `<script>` tag must NOT appear in the rendered HTML.
        expect(email.html).not.toContain('<script>alert(1)</script>');
        // Escaped form must be present.
        expect(email.html).toContain('&lt;script&gt;');
    });

    it('shows the "and N more" hint when rows exceed the preview cap', () => {
        // Preview limit is 10. Build 25 rows.
        const rows = Array.from({ length: 25 }, (_, i) => ({
            user: { id: `u${i}`, full_name: `User ${i}` },
            task: { id: `t${i}`, title: `Task ${i}` },
            billable_minutes: 60,
            non_billable_minutes: 0,
            hourly_rate: 2500,
            billable_amount: 2500,
        }));
        const fixture = billingFixture({ rows });
        const email = renderReportSubscriptionEmail('billing', fixture, 'Sub');

        expect(email.html).toContain('and 15 more rows');
    });

    it('omits the "and N more" hint when rows fit within the preview cap', () => {
        const email = renderReportSubscriptionEmail('billing', billingFixture(), 'Sub');
        expect(email.html).not.toMatch(/and \d+ more rows/);
    });

    it('renders a placeholder for empty rows[]', () => {
        const empty = billingFixture({ rows: [] });
        const email = renderReportSubscriptionEmail('billing', empty, 'Sub');
        expect(email.html).toContain('No rows');
    });

    it('handles attendance report shape', () => {
        const attendance: AttendanceReportResult = {
            from_date: '2026-04-01',
            to_date: '2026-04-30',
            rows: [
                {
                    user: { id: 'u1', full_name: 'Anna' },
                    present: 18,
                    absent: 0,
                    on_leave: 2,
                    holiday: 1,
                    weekend: 8,
                    incomplete: 1,
                    total_days: 30,
                },
            ],
        };
        const email = renderReportSubscriptionEmail('attendance', attendance, 'Sub');
        expect(email.subject).toContain('Attendance report');
        expect(email.html).toContain('Anna');
    });

    it('handles leave report shape', () => {
        const leaves: LeaveReportResult = {
            year: 2026,
            rows: [
                {
                    user: { id: 'u1', full_name: 'Anna' },
                    by_type: [
                        {
                            leave_type: { id: 'lt1', key: 'CL', label: 'Casual Leave' },
                            allocated: 12,
                            carried_forward: 0,
                            used: 2,
                            pending: 0,
                            adjusted: 0,
                            monthly_forfeited: 0,
                            available: 10,
                        },
                    ],
                },
            ],
        };
        const email = renderReportSubscriptionEmail('leaves', leaves, 'Sub');
        expect(email.subject).toContain('Leave report');
        expect(email.html).toContain('Casual Leave');
    });
});
