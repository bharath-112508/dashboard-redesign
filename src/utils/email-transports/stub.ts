import logger from '../logger.js';
import { NODE_ENV } from '../../config/server.config.js';

import type { EmailTransport } from './types.js';

/**
 * Console-stub transport (dev / test default).
 *
 * Nothing leaves the process. In `NODE_ENV=development` we log the
 * full subject + a 280-char text preview so the developer can
 * eyeball templates without hooking up a real provider; in
 * production (where the operator should NEVER select this) we
 * downgrade to a masked-recipient log line + the context tag, so a
 * misconfiguration is loud + observable but doesn't leak email
 * bodies into structured logs.
 */
export const stubTransport: EmailTransport = async (msg) => {
    if (NODE_ENV === 'production') {
        logger.warn(
            { to_masked: maskEmail(msg.to), subject: msg.subject, context: msg.context ?? null },
            'Email transport=stub in production — no outbound delivery (likely misconfiguration)'
        );
        return;
    }
    logger.info(
        {
            to: msg.to,
            subject: msg.subject,
            context: msg.context ?? null,
            text_preview: msg.text.slice(0, 280),
        },
        'DEV: email (transport=stub)'
    );
};

const maskEmail = (email: string): string => {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length <= 2 ? '*'.repeat(local.length) : `${local[0]}***${local.slice(-1)}`;
    return `${maskedLocal}@${domain}`;
};
