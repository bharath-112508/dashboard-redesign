import 'dotenv/config';

const getEnv = (key: string, defaultValue?: string): string => {
    const value = process.env[key] || defaultValue;

    if (value === undefined) {
        throw new Error(`Missing environment variable ${key}`);
    }

    return value;
};

// Server
export const NODE_ENV = getEnv('NODE_ENV', 'development');
export const PORT = Number(getEnv('PORT', '3001'));
export const LOG_LEVEL = getEnv('LOG_LEVEL', NODE_ENV === 'production' ? 'info' : 'debug');

// CORS — comma-separated origins, or "*" for all (dev only)
export const CORS_ORIGINS: string[] = getEnv('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

// Database
export const DB_URI = getEnv('MONGO_URI');

// JWT — plan-aligned TTLs: access 8h / refresh 5d
export const JWT_SECRET = getEnv('JWT_SECRET');
export const JWT_EXPIRES_IN = getEnv('JWT_EXPIRES_IN', '8h');
export const JWT_REFRESH_SECRET = getEnv('JWT_REFRESH_SECRET');
export const JWT_REFRESH_EXPIRES_IN = getEnv('JWT_REFRESH_EXPIRES_IN', '5d');

// MFA — AES-256-GCM key for TOTP secret-at-rest encryption.
// Base64-encoded 32 raw bytes. Validated at boot: a short / non-base64 key aborts startup
// rather than silently weakening encryption.
export const MFA_ENCRYPTION_KEY = getEnv('MFA_ENCRYPTION_KEY');
export const MFA_ISSUER = getEnv('MFA_ISSUER', 'Viljetech');

// Password reset — base URL embedded into password-reset emails.
// The final link is built as `${APP_BASE_URL}${PASSWORD_RESET_URL_PATH}?token=<...>`.
export const APP_BASE_URL = getEnv('APP_BASE_URL', 'http://localhost:5173');
export const PASSWORD_RESET_URL_PATH = getEnv('PASSWORD_RESET_URL_PATH', '/reset-password');

// Azure Blob Storage — used by `task_attachments` (Step 21) and profile
// photos (Step 22). All blobs live in **private** containers; the API mints
// short-lived SAS tokens for upload + download.
//
// Auth: prefer `AZURE_STORAGE_CONNECTION_STRING` (one variable, the SDK pulls
// account name + key out of it); fall back to the explicit name + key pair
// for environments that pass them separately. SAS signing requires the
// account key — managed-identity / SAS-only credentials cannot mint child
// SAS, so we don't accept them here.
//
// All four are optional at boot — startup must not fail when the platform is
// being bootstrapped without storage. The Blob client throws a clear error
// the first time a SAS is requested if the env is missing.
export const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING ?? null;
export const AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? null;
export const AZURE_STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY ?? null;
export const AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER = getEnv(
    'AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER',
    'task-attachments'
);
export const AZURE_BLOB_PROFILE_PHOTOS_CONTAINER = getEnv('AZURE_BLOB_PROFILE_PHOTOS_CONTAINER', 'profile-photos');

// Rate limits (per IP, in-memory).
//   GENERAL_RATE_LIMIT_MAX — applied to /api/* (window: 60 s)
//   AUTH_RATE_LIMIT_MAX    — applied to /auth/login, /auth/refresh, /auth/forgot-password,
//                            /auth/reset-password, /auth/change-password, /auth/mfa/* (window: 15 min)
//
// Production defaults match Company_Management_Plan.md §7.2 (10 failed auth / 15 min);
// local smoke environments bump these so the bash smokes can exercise the
// per-user lockout (5 wrong → 423) without colliding with the per-IP cap.
export const GENERAL_RATE_LIMIT_MAX = Number(getEnv('GENERAL_RATE_LIMIT_MAX', '120'));
export const AUTH_RATE_LIMIT_MAX = Number(getEnv('AUTH_RATE_LIMIT_MAX', '10'));
