import { APP_BASE_URL, PASSWORD_RESET_URL_PATH } from '../config/server.config.js';
import { getEmailTransport } from './email-transports/index.js';

import type { EmailAttachment } from './email-transports/types.js';
export type { EmailAttachment } from './email-transports/types.js';

/**
 * Mailer abstraction (BACKEND_AUDIT.md P0-1).
 *
 * Public surface (unchanged from the legacy stub):
 *   - `sendEmail(...)`         — generic transport-shaped send.
 *   - `sendPasswordResetEmail` — convenience wrapper.
 *   - `escapeHtml`             — HTML-escape helper (also used by
 *                                report-export PDF templates).
 *
 * Implementation now delegates to the pluggable transport in
 * `email-transports/`. `EMAIL_TRANSPORT` selects between:
 *   - `stub`    (default, dev/test) — logs only, no outbound delivery.
 *   - `acs`     — Azure Communication Services Email.
 *   - `mailjet` — Mailjet Send API.
 *
 * Keeping `sendEmail` as the only public surface means call-sites
 * (`notification-dispatcher.service`, `password-reset.service`, etc.)
 * are oblivious to transport. Adding a new provider is a single new
 * file + one switch arm in the factory.
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
    /**
     * Optional attachments (V2-BE-13). Each entry is `{ filename,
     * contentType, content: Buffer }`; transports convert to their
     * provider-native shape (ACS base64, Mailjet base64, stub log).
     * The mailer does NOT cap size — callers (e.g.,
     * `report-subscription.service`) own the limit + fallback policy.
     */
    attachments?: EmailAttachment[];
}

export const sendEmail = async (input: SendEmailInput): Promise<void> => {
    const transport = getEmailTransport();
    await transport({
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        context: input.context,
        attachments: input.attachments,
    });
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

/**
 * Tiny HTML escape — enough to protect against the email values we control
 * (full_name, leave reason, etc.) being interpreted as HTML in the rendered
 * message. Re-exported because `email-templates.ts` and the puppeteer PDF
 * generator's HTML-builder both depend on it.
 */
export const escapeHtml = (input: string): string =>
    input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
