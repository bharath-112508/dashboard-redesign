import {
    ACS_CONNECTION_STRING,
    ACS_FROM_ADDRESS,
    EMAIL_TRANSPORT,
    MAILJET_API_KEY,
    MAILJET_API_SECRET,
    MAILJET_FROM_ADDRESS,
    MAILJET_FROM_NAME,
} from '../../config/server.config.js';
import { buildAcsTransport } from './acs.js';
import { buildMailjetTransport } from './mailjet.js';
import { stubTransport } from './stub.js';

import type { EmailTransport } from './types.js';

/**
 * Email transport factory.
 *
 * Resolves a single `EmailTransport` based on `EMAIL_TRANSPORT` (read
 * once at boot via `server.config.ts`). The transport is cached on
 * first call so tests or the dispatcher can use a stable reference.
 *
 * If a future contributor wires more transports (SES, SendGrid,
 * Postmark, …), add a new file under this directory + register it
 * in the switch below + extend `EMAIL_TRANSPORTS` in `types.ts`.
 */

let cachedTransport: EmailTransport | null = null;

const buildTransport = (): EmailTransport => {
    switch (EMAIL_TRANSPORT) {
        case 'acs':
            // Boot-time validation in `server.config.ts` already
            // confirmed both env vars are present.
            return buildAcsTransport({
                connectionString: ACS_CONNECTION_STRING!,
                fromAddress: ACS_FROM_ADDRESS!,
            });
        case 'mailjet':
            return buildMailjetTransport({
                apiKey: MAILJET_API_KEY!,
                apiSecret: MAILJET_API_SECRET!,
                fromAddress: MAILJET_FROM_ADDRESS!,
                fromName: MAILJET_FROM_NAME,
            });
        case 'stub':
        default:
            return stubTransport;
    }
};

export const getEmailTransport = (): EmailTransport => {
    if (cachedTransport) return cachedTransport;
    cachedTransport = buildTransport();
    return cachedTransport;
};

/**
 * Test seam — clear the cached transport so a `vi.resetModules()` +
 * env mutation in a test picks up the new selection on the next
 * `getEmailTransport()` call.
 */
export const __resetEmailTransportCache = (): void => {
    cachedTransport = null;
};

export type { EmailMessage, EmailTransport } from './types.js';
export { EMAIL_TRANSPORTS, isEmailTransport } from './types.js';
