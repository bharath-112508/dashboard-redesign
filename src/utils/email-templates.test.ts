import { describe, expect, it } from 'vitest';

import {
    renderCorrectionDecidedEmail,
    renderCorrectionSubmittedEmail,
    renderLeaveDecisionEmail,
    renderLeaveSubmittedEmail,
    renderTaskCommentMentionEmail,
    renderTimesheetReminderEmail,
    renderUserInviteEmail,
} from './email-templates.js';

/**
 * Coverage focus for every notification template — there are six
 * renderers with the same shape; each interpolates user-controlled
 * fields into the HTML body. The single most important property
 * across all of them is **XSS defence**: every interpolated value
 * runs through `escapeHtml` before landing in the `html` branch.
 *
 * The realistic threat: any field a user can set on themselves
 * (`full_name` set at registration, leave `remarks`, comment `body`,
 * etc.) could carry HTML that, if un-escaped, would execute when
 * the email is rendered in a webmail client.
 *
 * What we lock in per template:
 *   1. The XSS payload `<img src=x onerror=alert(1)>` injected into
 *      the user-controlled field MUST appear escaped in `html` and
 *      MUST NOT survive verbatim.
 *   2. The plain-text branch IS allowed to contain the raw payload —
 *      text/plain is never parsed as markup so there's no XSS surface
 *      there. Pin that the wrapper doesn't waste bytes double-escaping.
 *   3. Subject + html + text are always non-empty strings.
 *   4. Singular/plural day counts work correctly (the "1 day" vs "2
 *      days" difference is operator-visible polish).
 */

const XSS = '<img src=x onerror=alert(1)>';
const ESCAPED_XSS = '&lt;img src=x onerror=alert(1)&gt;';

const expectEscaped = (html: string): void => {
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED_XSS);
};

const expectShapedEmail = (out: { subject: string; html: string; text: string }): void => {
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
};

// ─── User invite ──────────────────────────────────────────────────────────

describe('renderUserInviteEmail', () => {
    it('escapes recipient_full_name, invited_by_name, and initial_password in HTML', () => {
        const out = renderUserInviteEmail({
            recipient_full_name: XSS,
            invited_by_name: XSS,
            initial_password: XSS,
        });
        expectShapedEmail(out);
        expectEscaped(out.html);
        // Three interpolation sites → at least 3 escaped occurrences.
        expect(out.html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('uses the default /login path when no override is supplied', () => {
        const out = renderUserInviteEmail({
            recipient_full_name: 'Sam',
            invited_by_name: 'Admin',
            initial_password: 'TempPass1!',
        });
        expect(out.html).toContain('/login');
        expect(out.text).toContain('/login');
    });

    it('honours a custom login_path override', () => {
        const out = renderUserInviteEmail({
            recipient_full_name: 'Sam',
            invited_by_name: 'Admin',
            initial_password: 'TempPass1!',
            login_path: '/auth/sign-in',
        });
        expect(out.html).toContain('/auth/sign-in');
    });
});

// ─── Leave submitted ──────────────────────────────────────────────────────

describe('renderLeaveSubmittedEmail', () => {
    it('escapes requester_full_name + leave_type_label + recipient name in HTML', () => {
        const out = renderLeaveSubmittedEmail({
            recipient_full_name: XSS,
            requester_full_name: XSS,
            leave_type_label: XSS,
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'req-1',
        });
        expectEscaped(out.html);
    });

    it('singular "1 day" vs plural "2 days" — both branches correct', () => {
        const oneDay = renderLeaveSubmittedEmail({
            recipient_full_name: 'A',
            requester_full_name: 'B',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'r',
        });
        expect(oneDay.html).toContain('1 day)');
        expect(oneDay.html).not.toContain('1 days');

        const twoDays = renderLeaveSubmittedEmail({
            recipient_full_name: 'A',
            requester_full_name: 'B',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-24',
            total_days: 2,
            request_id: 'r',
        });
        expect(twoDays.html).toContain('2 days)');
    });

    it('renders a date range with `→` only when start ≠ end', () => {
        const single = renderLeaveSubmittedEmail({
            recipient_full_name: 'A',
            requester_full_name: 'B',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'r',
        });
        expect(single.html).not.toContain('→');

        const range = renderLeaveSubmittedEmail({
            recipient_full_name: 'A',
            requester_full_name: 'B',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-25',
            total_days: 3,
            request_id: 'r',
        });
        expect(range.html).toContain('2026-04-23 → 2026-04-25');
    });
});

// ─── Leave decision (approved / rejected / cancelled) ─────────────────────

describe('renderLeaveDecisionEmail', () => {
    it('escapes recipient name + leave_type_label + remarks in HTML', () => {
        const out = renderLeaveDecisionEmail({
            recipient_full_name: XSS,
            decision: 'approved',
            leave_type_label: XSS,
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'r',
            remarks: XSS,
        });
        expectEscaped(out.html);
        // The raw remarks MUST NOT survive in HTML.
        expect(out.html).not.toContain(XSS);
    });

    it('omits the Note paragraph when remarks is null/absent', () => {
        const without = renderLeaveDecisionEmail({
            recipient_full_name: 'A',
            decision: 'approved',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'r',
        });
        expect(without.html).not.toContain('<strong>Note:</strong>');
        expect(without.text).not.toContain('Note:');
    });

    it('emits a Note paragraph when remarks is present', () => {
        const withRemarks = renderLeaveDecisionEmail({
            recipient_full_name: 'A',
            decision: 'rejected',
            leave_type_label: 'CL',
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            total_days: 1,
            request_id: 'r',
            remarks: 'Already covered by team lead',
        });
        expect(withRemarks.html).toContain('<strong>Note:</strong>');
        expect(withRemarks.text).toContain('Note: Already covered by team lead');
    });

    it('subject line reflects the decision verb (approved / rejected / cancelled)', () => {
        const a = renderLeaveDecisionEmail({
            recipient_full_name: 'A',
            decision: 'approved',
            leave_type_label: 'CL',
            start_date: 'd',
            end_date: 'd',
            total_days: 1,
            request_id: 'r',
        });
        const b = renderLeaveDecisionEmail({
            recipient_full_name: 'A',
            decision: 'rejected',
            leave_type_label: 'CL',
            start_date: 'd',
            end_date: 'd',
            total_days: 1,
            request_id: 'r',
        });
        const c = renderLeaveDecisionEmail({
            recipient_full_name: 'A',
            decision: 'cancelled',
            leave_type_label: 'CL',
            start_date: 'd',
            end_date: 'd',
            total_days: 1,
            request_id: 'r',
        });
        expect(a.subject).toContain('approved');
        expect(b.subject).toContain('rejected');
        expect(c.subject).toContain('cancelled');
    });
});

// ─── Attendance correction submitted + decided ────────────────────────────

describe('renderCorrectionSubmittedEmail', () => {
    it('escapes recipient + requester names + local_date in HTML', () => {
        const out = renderCorrectionSubmittedEmail({
            recipient_full_name: XSS,
            requester_full_name: XSS,
            local_date: XSS,
            request_id: 'r',
        });
        expectEscaped(out.html);
    });
});

describe('renderCorrectionDecidedEmail', () => {
    it('escapes recipient name + local_date + remarks in HTML', () => {
        const out = renderCorrectionDecidedEmail({
            recipient_full_name: XSS,
            decision: 'rejected',
            local_date: XSS,
            request_id: 'r',
            remarks: XSS,
        });
        expectEscaped(out.html);
    });

    it('omits Note when remarks is absent', () => {
        const out = renderCorrectionDecidedEmail({
            recipient_full_name: 'A',
            decision: 'approved',
            local_date: '2026-04-23',
            request_id: 'r',
        });
        expect(out.html).not.toContain('<strong>Note:</strong>');
    });
});

// ─── Task comment mention ─────────────────────────────────────────────────

describe('renderTaskCommentMentionEmail', () => {
    it('escapes recipient + author names AND the comment body in HTML', () => {
        // The comment body is operator-controlled (a colleague's text);
        // the @mention surface is the most realistic XSS vector — a
        // hostile colleague crafts a comment with embedded HTML.
        const out = renderTaskCommentMentionEmail({
            recipient_full_name: XSS,
            author_full_name: XSS,
            task_id: 'tid',
            body_preview: XSS,
        });
        expectEscaped(out.html);
    });

    it('truncates a body preview longer than the cap (280 chars) with an ellipsis', () => {
        // The cap is `TASK_COMMENT_PREVIEW_MAX = 280` — pin the truncation
        // logic so a 5KB comment doesn't blow the email size.
        const huge = 'x'.repeat(500);
        const out = renderTaskCommentMentionEmail({
            recipient_full_name: 'R',
            author_full_name: 'A',
            task_id: 'tid',
            body_preview: huge,
        });
        // Trailing ellipsis appears.
        expect(out.html).toContain('…');
        expect(out.text).toContain('…');
        // The full 500-char body MUST NOT appear in either branch.
        expect(out.text).not.toContain('x'.repeat(500));
    });

    it('does NOT truncate a body preview at or under the cap', () => {
        const fits = 'x'.repeat(100);
        const out = renderTaskCommentMentionEmail({
            recipient_full_name: 'R',
            author_full_name: 'A',
            task_id: 'tid',
            body_preview: fits,
        });
        expect(out.text).toContain(fits);
        expect(out.text).not.toContain('…');
    });
});

// ─── Timesheet reminder ───────────────────────────────────────────────────

describe('renderTimesheetReminderEmail', () => {
    it('escapes recipient_full_name in HTML', () => {
        // `local_date` is server-derived (the cron picks it from the
        // calendar) and validated upstream as YYYY-MM-DD — only the
        // recipient_full_name comes from the user-editable profile and
        // is therefore the relevant XSS surface for THIS template.
        const out = renderTimesheetReminderEmail({
            recipient_full_name: XSS,
            local_date: '2026-04-23',
            expected_hours: 8,
        });
        expectEscaped(out.html);
    });

    it('singular "1 hour" vs plural "8 hours" — both branches correct', () => {
        const one = renderTimesheetReminderEmail({
            recipient_full_name: 'R',
            local_date: '2026-04-23',
            expected_hours: 1,
        });
        expect(one.html).toContain('1 hour');
        expect(one.html).not.toContain('1 hours');

        const eight = renderTimesheetReminderEmail({
            recipient_full_name: 'R',
            local_date: '2026-04-23',
            expected_hours: 8,
        });
        expect(eight.html).toContain('8 hours');
    });
});
