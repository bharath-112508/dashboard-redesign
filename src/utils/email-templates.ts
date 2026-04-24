import { APP_BASE_URL } from '../config/server.config.js';
import { escapeHtml } from './mailer.js';

/**
 * Notification email templates (Step 11).
 *
 * Each template is a pure function returning the same `{ subject, html, text }`
 * shape that `mailer.sendEmail` accepts. They live here (not under
 * `email-templates/`) because the set is small and rendering is dependency-free
 * — when ACS lands and we need richer layouts we can split per-event into a
 * folder and introduce a layout helper without touching call-sites.
 *
 * Conventions:
 *   - All templates accept a `recipient_full_name` and call the recipient by
 *     name in the greeting. Keep the greeting cordial — these are workflow
 *     emails, not marketing.
 *   - Use `escapeHtml` for every interpolated value in the HTML branch (the
 *     text branch is plain text and doesn't need it).
 *   - The body is intentionally short. The bell icon + the deep-link give the
 *     full context; email is a "tap to go look" nudge.
 */

export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}

const wrap = (body: string): string =>
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">${body}</div>`;

const link = (url: string, label: string): string =>
    `<a href="${url}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(label)}</a>`;

const buildAppLink = (path: string): string => `${APP_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

// ─── User invite (admin onboarding) ───────────────────────────────────────

export interface InviteEmailInput {
    recipient_full_name: string;
    invited_by_name: string;
    initial_password: string;
    /** App login path; defaults to `/login`. */
    login_path?: string;
}

export const renderUserInviteEmail = (input: InviteEmailInput): RenderedEmail => {
    const url = buildAppLink(input.login_path ?? '/login');
    const subject = 'Welcome to Viljetech — your account is ready';
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p>${escapeHtml(input.invited_by_name)} just created a Viljetech account for you.</p>
        <p>You can sign in at ${link(url, url)} with these credentials:</p>
        <ul>
          <li><strong>Initial password:</strong> ${escapeHtml(input.initial_password)}</li>
        </ul>
        <p>You'll be asked to change this password the first time you log in. If you weren't expecting this email, please reply to your administrator.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `${input.invited_by_name} just created a Viljetech account for you.\n\n` +
        `Sign in: ${url}\n` +
        `Initial password: ${input.initial_password}\n\n` +
        "You'll be asked to change this password on first login.\n" +
        "If you weren't expecting this email, please reply to your administrator.\n";
    return { subject, html, text };
};

// ─── Leave: submitted (to managers + admins) ──────────────────────────────

export interface LeaveSubmittedEmailInput {
    recipient_full_name: string;
    requester_full_name: string;
    leave_type_label: string;
    start_date: string;
    end_date: string;
    total_days: number;
    request_id: string;
}

export const renderLeaveSubmittedEmail = (input: LeaveSubmittedEmailInput): RenderedEmail => {
    const url = buildAppLink(`/leaves/${input.request_id}`);
    const subject = `Leave request from ${input.requester_full_name}`;
    const range = input.start_date === input.end_date ? input.start_date : `${input.start_date} → ${input.end_date}`;
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p>${escapeHtml(input.requester_full_name)} just submitted a leave request:</p>
        <ul>
          <li><strong>Type:</strong> ${escapeHtml(input.leave_type_label)}</li>
          <li><strong>Dates:</strong> ${escapeHtml(range)} (${input.total_days} day${input.total_days === 1 ? '' : 's'})</li>
        </ul>
        <p>${link(url, 'Review the request')} when you have a moment.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `${input.requester_full_name} just submitted a leave request.\n` +
        `Type: ${input.leave_type_label}\n` +
        `Dates: ${range} (${input.total_days} day${input.total_days === 1 ? '' : 's'})\n\n` +
        `Review: ${url}\n`;
    return { subject, html, text };
};

// ─── Leave: approved / rejected / cancelled (to requester) ────────────────

export interface LeaveDecisionEmailInput {
    recipient_full_name: string;
    decision: 'approved' | 'rejected' | 'cancelled';
    leave_type_label: string;
    start_date: string;
    end_date: string;
    total_days: number;
    request_id: string;
    actor_full_name?: string;
    remarks?: string | null;
}

export const renderLeaveDecisionEmail = (input: LeaveDecisionEmailInput): RenderedEmail => {
    const url = buildAppLink(`/leaves/${input.request_id}`);
    const range = input.start_date === input.end_date ? input.start_date : `${input.start_date} → ${input.end_date}`;
    const verb = input.decision === 'approved' ? 'approved' : input.decision === 'rejected' ? 'rejected' : 'cancelled';
    const subject = `Your leave request was ${verb}`;
    const actorPhrase = input.actor_full_name ? ` by ${input.actor_full_name}` : '';
    const remarksHtml = input.remarks ? `<p><strong>Note:</strong> ${escapeHtml(input.remarks)}</p>` : '';
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p>Your ${escapeHtml(input.leave_type_label)} request for <strong>${escapeHtml(range)}</strong> (${input.total_days} day${input.total_days === 1 ? '' : 's'}) was <strong>${escapeHtml(verb)}</strong>${escapeHtml(actorPhrase)}.</p>
        ${remarksHtml}
        <p>${link(url, 'View the request')}.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `Your ${input.leave_type_label} request for ${range} (${input.total_days} day${input.total_days === 1 ? '' : 's'}) was ${verb}${actorPhrase}.\n` +
        (input.remarks ? `Note: ${input.remarks}\n` : '') +
        `\nView: ${url}\n`;
    return { subject, html, text };
};

// ─── Attendance correction: submitted (to reviewers) ──────────────────────

export interface CorrectionSubmittedEmailInput {
    recipient_full_name: string;
    requester_full_name: string;
    local_date: string;
    request_id: string;
}

export const renderCorrectionSubmittedEmail = (input: CorrectionSubmittedEmailInput): RenderedEmail => {
    const url = buildAppLink(`/attendance/correction-requests/${input.request_id}`);
    const subject = `Attendance correction from ${input.requester_full_name}`;
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p>${escapeHtml(input.requester_full_name)} requested a correction for their attendance record on <strong>${escapeHtml(input.local_date)}</strong>.</p>
        <p>${link(url, 'Review the request')}.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `${input.requester_full_name} requested an attendance correction for ${input.local_date}.\n\n` +
        `Review: ${url}\n`;
    return { subject, html, text };
};

// ─── Attendance correction: decided (to employee) ─────────────────────────

export interface CorrectionDecidedEmailInput {
    recipient_full_name: string;
    decision: 'approved' | 'rejected';
    local_date: string;
    request_id: string;
    actor_full_name?: string;
    remarks?: string | null;
}

export const renderCorrectionDecidedEmail = (input: CorrectionDecidedEmailInput): RenderedEmail => {
    const url = buildAppLink(`/attendance/correction-requests/${input.request_id}`);
    const subject = `Your attendance correction was ${input.decision}`;
    const actorPhrase = input.actor_full_name ? ` by ${input.actor_full_name}` : '';
    const remarksHtml = input.remarks ? `<p><strong>Note:</strong> ${escapeHtml(input.remarks)}</p>` : '';
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p>Your attendance correction request for <strong>${escapeHtml(input.local_date)}</strong> was <strong>${escapeHtml(input.decision)}</strong>${escapeHtml(actorPhrase)}.</p>
        ${remarksHtml}
        <p>${link(url, 'View the request')}.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `Your attendance correction request for ${input.local_date} was ${input.decision}${actorPhrase}.\n` +
        (input.remarks ? `Note: ${input.remarks}\n` : '') +
        `\nView: ${url}\n`;
    return { subject, html, text };
};

// ─── Task: @mention in a comment (to mentioned user) ──────────────────────

export interface TaskCommentMentionEmailInput {
    recipient_full_name: string;
    author_full_name: string;
    task_id: string;
    /** Pre-sanitised, plain-text comment body. We truncate before send. */
    body_preview: string;
}

const TASK_COMMENT_PREVIEW_MAX = 280;

export const renderTaskCommentMentionEmail = (input: TaskCommentMentionEmailInput): RenderedEmail => {
    const url = buildAppLink(`/tasks/${input.task_id}`);
    const subject = `${input.author_full_name} mentioned you in a comment`;
    const previewRaw =
        input.body_preview.length > TASK_COMMENT_PREVIEW_MAX
            ? `${input.body_preview.slice(0, TASK_COMMENT_PREVIEW_MAX).trimEnd()}…`
            : input.body_preview;
    const html = wrap(`
        <p>Hi ${escapeHtml(input.recipient_full_name)},</p>
        <p><strong>${escapeHtml(input.author_full_name)}</strong> mentioned you in a comment on a task.</p>
        <blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #d1d5db;color:#4b5563;white-space:pre-wrap;">${escapeHtml(previewRaw)}</blockquote>
        <p>${link(url, 'Open the task')}.</p>
    `);
    const text =
        `Hi ${input.recipient_full_name},\n\n` +
        `${input.author_full_name} mentioned you in a comment on a task.\n\n` +
        `${previewRaw}\n\n` +
        `Open: ${url}\n`;
    return { subject, html, text };
};
