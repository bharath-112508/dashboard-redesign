import logger from './logger.js';
import { APP_BASE_URL, NODE_ENV, PASSWORD_RESET_URL_PATH } from '../config/server.config.js';

/**
 * Mailer abstraction. The real driver (Azure Communication Services) is
 * deferred; this dev-stub logs every send at INFO and in non-production also
 * includes the token so the developer can copy-paste the link from the console.
 *
 * To swap in ACS later, implement a `Mailer` interface with the same method
 * names and replace the default export. Nothing else in the app touches the
 * transport details.
 */

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

    // In production we only log the *fact* of a send. In dev we log the link
    // too so you can click from the terminal without needing a real inbox.
    if (NODE_ENV === 'production') {
        logger.info({ to_masked: maskEmail(input.to) }, 'Password reset email dispatched');
        return;
    }

    logger.info(
        {
            to: input.to,
            name: input.full_name,
            reset_url: link,
            hint: 'Azure Communication Services is deferred — using console stub',
        },
        'DEV: Password reset email'
    );
};

const maskEmail = (email: string): string => {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length <= 2 ? '*'.repeat(local.length) : `${local[0]}***${local.slice(-1)}`;
    return `${maskedLocal}@${domain}`;
};
