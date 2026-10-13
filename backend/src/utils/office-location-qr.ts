import { randomBytes } from 'node:crypto';

import QRCode from 'qrcode';

import { APP_BASE_URL } from '../config/server.config.js';
import { CHECK_IN_URL_PATH, QR_TOKEN_BYTES } from '../constants/office-location.js';

/**
 * Office-location QR primitives.
 *
 * Why base64url (and not hex / base32):
 *  - 24 raw bytes → 32 base64url chars → 192 bits of entropy.
 *  - URL-safe alphabet, so the token can sit in a query string with no
 *    percent-encoding round-trips.
 *  - More compact than hex (which would be 48 chars), so the printed QR stays
 *    physically smaller.
 */

export const generateQrToken = (): string => {
    return randomBytes(QR_TOKEN_BYTES).toString('base64url');
};

/**
 * The URL a phone hits when the printed QR is scanned. The FE owns
 * `${APP_BASE_URL}${CHECK_IN_URL_PATH}` and forwards the token to
 * `POST /attendance/check-in` (Step 8) once the user is authenticated.
 */
export const buildCheckInUrl = (qr_code_token: string): string => {
    return `${APP_BASE_URL}${CHECK_IN_URL_PATH}?token=${encodeURIComponent(qr_code_token)}`;
};

/**
 * Render the check-in URL as a base64 PNG data URL. We render on every
 * response (rather than caching) so a regenerated token is reflected
 * immediately and there's no stale-cache surface to reason about. Cost is
 * O(<1 ms) per location at typical sizes.
 *
 * `errorCorrectionLevel: 'M'` matches the MFA setup QR — comfortable for
 * camera-based scanning even when partially obscured.
 */
export const renderCheckInQrDataUrl = async (qr_code_token: string): Promise<string> => {
    const url = buildCheckInUrl(qr_code_token);
    return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1 });
};
