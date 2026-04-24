import { ROLES, type RoleType } from './roles.js';

/**
 * Office-location constants — Step 7.
 *
 * Authorization model (API_Contract.md §4.2):
 *  - Reads (list / get) — Admin or Manager. Employees never browse the list;
 *    they scan a printed QR which carries a token resolved at check-in time
 *    by `/attendance/check-in` (Step 8).
 *  - Writes (create / patch / regenerate-qr / delete) — Admin only.
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

export const OFFICE_LOCATION_READ_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER];
export const OFFICE_LOCATION_WRITE_ROLES: readonly RoleType[] = [ROLES.ADMIN];

export const QR_TOKEN_BYTES = 24;
export const QR_TOKEN_REGENERATION_RETRY_LIMIT = 5;

export const CHECK_IN_URL_PATH = '/check-in';
