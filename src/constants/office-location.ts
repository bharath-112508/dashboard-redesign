/**
 * Office-location constants — Step 7.
 *
 * Authorization (Step 47): route gates use
 * `requirePermission(office_location.read|write)`.
 *
 * QR encoding:
 *  - Each location carries a single opaque `qr_code_token` (base64url of 24
 *    random bytes → 32 chars → 192 bits of entropy → effectively no chance of
 *    collision). The token is rotated by `POST /office-locations/:id/regenerate-qr`,
 *    which immediately invalidates any previously-printed QR sheets.
 *  - The QR PNG embeds a check-in URL of the shape
 *    `${APP_BASE_URL}${CHECK_IN_URL_PATH}?token=<qr_code_token>` so the FE
 *    deep-link can pre-fill the token field.
 */

export const QR_TOKEN_BYTES = 24;
export const QR_TOKEN_REGENERATION_RETRY_LIMIT = 5;

export const CHECK_IN_URL_PATH = '/check-in';
