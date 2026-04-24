import logger from './logger.js';
import { APP_BASE_URL, NODE_ENV, PASSWORD_RESET_URL_PATH } from '../config/server.config.js';

/**
 * Mailer abstraction.
 *
 * The real driver (Azure Communication Services per Company_Management_Plan
 * §6.7) is deferred; this dev-stub logs every send at INFO and in
 * non-production also includes the rendered subject/body so the developer can
 * eyeball the templates from the console without needing a real inbox.
 *
 * Public surface:
 *   - `sendEmail(...)`        — generic transport-shaped send. Use this from
 *                               the notification dispatcher and from any new
 *                               feature that needs to email a user.
 *   - `sendPasswordResetEmail` — kept as a thin convenience wrapper around
 *                               `sendEmail` so the existing call-sites in
 *                               `password-reset.service.ts` keep working
 *                               unchanged.
 *
 * To swap in ACS later, replace the body of `sendEmail`. Nothing else in the
 * app touches transport details.
 */

export interface SendEmailInput {
    to: string;
    subject: string;
    html: string;
    text: string;
    /**
     * Optional context tag passed through to the structured log line so we
     * can correlate notification dispatches with their triggering event
     * (e.g. `'notification.leave_approved'`).
     */
    context?: string;
}

export const sendEmail = async (input: SendEmailInput): Promise<void> => {
    if (NODE_ENV === 'production') {
        logger.info(
            { to_masked: maskEmail(input.to), subject: input.subject, context: input.context ?? null },
            'Email dispatched'
        );
        return;
    }

    logger.info(
        {
            to: input.to,
            subject: input.subject,
            context: input.context ?? null,
            text_preview: input.text.slice(0, 280),
            hint: 'Azure Communication Services is deferred — using console stub',
        },
        'DEV: email'
    );
};

// ─── Password-reset wrapper (legacy call-site preserved) ──────────────────

export interface SendPasswordResetEmailInput {
    to: string;
    full_name: string;
    token: string;
}

const buildResetUrl = (token: string): string => {
    return `${APP_BASE_URL}${PASSWORD_RESET_URL_PATH}?token=${encodeURIComponent(token)}`;
};

export const sendPasswordResetEmail = async (input: SendPasswordResetEmailInput): Promise<void> => {
    const link = buildResetUrl(input.token);
    const subject = 'Reset your Viljetech password';
    const html = `
        <p>Hi ${escapeHtml(input.full_name)},</p>
        <p>You (or someone using your email address) requested a password reset.</p>
        <p><a href="${link}">Click here to set a new password</a>. This link expires shortly.</p>
        <p>If you didn't make this request, you can safely ignore this email.</p>
    `.trim();
    const text =
        `Hi ${input.full_name},\n\n` +
        'You requested a password reset for your Viljetech account.\n' +
        `Open this link to set a new password (expires shortly):\n${link}\n\n` +
        "If you didn't make this request, you can safely ignore this email.\n";

    await sendEmail({ to: input.to, subject, html, text, context: 'password_reset' });
};

// ─── Helpers ──────────────────────────────────────────────────────────────

const maskEmail = (email: string): string => {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length <= 2 ? '*'.repeat(local.length) : `${local[0]}***${local.slice(-1)}`;
    return `${maskedLocal}@${domain}`;
};

/**
 * Tiny HTML escape — enough to protect against the email values we control
 * (full_name, leave reason, etc.) being interpreted as HTML in the rendered
 * message. We deliberately keep this dependency-free so swapping in ACS or
 * SendGrid later doesn't drag handlebars / mjml along.
 */
export const escapeHtml = (input: string): string =>
    input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
