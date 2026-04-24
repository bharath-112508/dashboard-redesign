import { RoleType } from '../constants/index.js';

/** Claims carried in every access token. */
export interface BaseJWTPayload {
    user_id: string;
    role: RoleType;
}

/** Refresh tokens carry a per-token `jti` so two tokens issued in the same second differ. */
export interface RefreshJWTPayload extends BaseJWTPayload {
    type: 'refresh';
    jti: string;
}

/** Shape returned by login / refresh (API_Contract §2.2, §2.4). */
export interface AuthTokenPair {
    access_token: string;
    access_token_expires_at: string;
    refresh_token: string;
    refresh_token_expires_at: string;
}
