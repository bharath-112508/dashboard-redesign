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

// ─── JWT key rotation via `kid` ─────────────────────────────────────────
//
// Single-key mode (default): `JWT_SECRET` is used for every sign + verify;
// no `kid` header on issued tokens. Rotating it logs everyone out, so we
// support a multi-key mode for graceful rotation:
//
//   1. Set `JWT_SECRET_<kid>` env vars (any naming, e.g.
//      `JWT_SECRET_v1=oldvalue`, `JWT_SECRET_v2=newvalue`).
//   2. Set `JWT_ACTIVE_KID=<kid>` to pick which key signs new tokens.
//   3. The verifier reads the `kid` header from the token, looks up the
//      matching secret, and accepts it. Tokens signed BEFORE rotation
//      (no `kid` header) still verify against the legacy `JWT_SECRET`.
//
// Rotation procedure (operator):
//   a. Add `JWT_SECRET_v2=<new>`, `JWT_ACTIVE_KID=v2`, leave `JWT_SECRET`
//      and any existing `JWT_SECRET_v1` in place. Restart.
//      → New tokens signed with v2 (carry `kid=v2`); v1 + legacy tokens
//        still verify.
//   b. Wait `max(access_ttl, refresh_ttl)` (today: 5 days) for all
//      pre-rotation tokens to expire naturally.
//   c. Remove `JWT_SECRET_v1` (and optionally legacy `JWT_SECRET`) and
//      restart.
//
// Same pattern for the refresh secret (`JWT_REFRESH_SECRET_<kid>` +
// `JWT_REFRESH_ACTIVE_KID`). Refresh + access registries are independent.
//
// See `BACKEND_AUDIT.md` P0-3 for the rationale.

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Read all `<prefix>_<kid>` env vars into a `Map<kid, secret>`. The
 * prefix matches `JWT_SECRET_` or `JWT_REFRESH_SECRET_`. Kid format is
 * conservative — alphanumeric / underscore / hyphen, ≤ 32 chars — so a
 * malicious kid in a forged token can't traverse the env namespace.
 */
const readKeyRegistry = (prefix: string): Map<string, string> => {
    const registry = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith(prefix)) continue;
        const kid = key.slice(prefix.length);
        if (!KID_PATTERN.test(kid)) continue;
        if (!value) continue;
        registry.set(kid, value);
    }
    return registry;
};

export const JWT_KEY_REGISTRY: ReadonlyMap<string, string> = readKeyRegistry('JWT_SECRET_');
export const JWT_ACTIVE_KID = process.env.JWT_ACTIVE_KID ?? null;
export const JWT_REFRESH_KEY_REGISTRY: ReadonlyMap<string, string> = readKeyRegistry('JWT_REFRESH_SECRET_');
export const JWT_REFRESH_ACTIVE_KID = process.env.JWT_REFRESH_ACTIVE_KID ?? null;

// Boot-time sanity: if an active kid is named, that kid must exist in the
// registry. Otherwise the first sign call would silently fall back to the
// legacy single-key path — surprising and likely a config error.
if (JWT_ACTIVE_KID && !JWT_KEY_REGISTRY.has(JWT_ACTIVE_KID)) {
    throw new Error(
        `JWT_ACTIVE_KID="${JWT_ACTIVE_KID}" but no matching JWT_SECRET_${JWT_ACTIVE_KID} env var. ` +
            `Available kids: [${[...JWT_KEY_REGISTRY.keys()].join(', ') || '(none)'}]`
    );
}
if (JWT_REFRESH_ACTIVE_KID && !JWT_REFRESH_KEY_REGISTRY.has(JWT_REFRESH_ACTIVE_KID)) {
    throw new Error(
        `JWT_REFRESH_ACTIVE_KID="${JWT_REFRESH_ACTIVE_KID}" but no matching ` +
            `JWT_REFRESH_SECRET_${JWT_REFRESH_ACTIVE_KID} env var. Available kids: ` +
            `[${[...JWT_REFRESH_KEY_REGISTRY.keys()].join(', ') || '(none)'}]`
    );
}

// MFA — AES-256-GCM key for TOTP secret-at-rest encryption.
// Base64-encoded 32 raw bytes. Validated at boot: a short / non-base64 key aborts startup
// rather than silently weakening encryption.
export const MFA_ENCRYPTION_KEY = getEnv('MFA_ENCRYPTION_KEY');
export const MFA_ISSUER = getEnv('MFA_ISSUER', 'Viljetech');

// ─── MFA encryption-key rotation (BACKEND_AUDIT.md R16) ────────────────
//
// Single-key mode (default): `MFA_ENCRYPTION_KEY` only. Ciphertext is
// `iv.ct.tag` (no kid prefix). Rotating the key would orphan every
// existing `mfa_secret_encrypted` — the only recovery is mass MFA
// disable + re-enroll.
//
// Rotation mode: register multiple keys via `MFA_ENCRYPTION_KEY_<kid>`
// + `MFA_ENCRYPTION_ACTIVE_KID` (mirrors the JWT pattern from P0-3).
// New encryptions stamp the kid in the ciphertext blob; decrypt looks
// up the kid in the registry. Tokens written before rotation (no kid
// prefix) verify against `MFA_ENCRYPTION_KEY` for the legacy fallback.
//
// Rotation procedure:
//   1. Add `MFA_ENCRYPTION_KEY_v2=<new>` + `MFA_ENCRYPTION_ACTIVE_KID=v2`,
//      restart. New encryptions carry `kid=v2`; legacy ciphertexts
//      still decrypt against `MFA_ENCRYPTION_KEY`.
//   2. Trigger a re-encryption pass: every `users.mfa_secret_encrypted`
//      is read + re-encrypted under the active kid. (Run as an admin
//      endpoint or one-off script — the codebase ships this as a
//      runbook task, not an auto-migration, so the operator decides
//      timing.) After completion, every row carries `kid=v2`.
//   3. Drop `MFA_ENCRYPTION_KEY_v1` + the legacy `MFA_ENCRYPTION_KEY`.

const readMfaKeyRegistry = (): Map<string, string> => {
    const prefix = 'MFA_ENCRYPTION_KEY_';
    const KID_PATTERN_LOCAL = /^[A-Za-z0-9_-]{1,32}$/;
    const registry = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith(prefix)) continue;
        const kid = key.slice(prefix.length);
        if (!KID_PATTERN_LOCAL.test(kid)) continue;
        if (!value) continue;
        registry.set(kid, value);
    }
    return registry;
};

export const MFA_ENCRYPTION_KEY_REGISTRY: ReadonlyMap<string, string> = readMfaKeyRegistry();
export const MFA_ENCRYPTION_ACTIVE_KID = process.env.MFA_ENCRYPTION_ACTIVE_KID ?? null;

if (MFA_ENCRYPTION_ACTIVE_KID && !MFA_ENCRYPTION_KEY_REGISTRY.has(MFA_ENCRYPTION_ACTIVE_KID)) {
    throw new Error(
        `MFA_ENCRYPTION_ACTIVE_KID="${MFA_ENCRYPTION_ACTIVE_KID}" but no matching ` +
            `MFA_ENCRYPTION_KEY_${MFA_ENCRYPTION_ACTIVE_KID} env var. Available kids: ` +
            `[${[...MFA_ENCRYPTION_KEY_REGISTRY.keys()].join(', ') || '(none)'}]`
    );
}

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

// ─── Reverse-proxy trust (BACKEND_AUDIT.md P2-13) ──────────────────────
//
// Express's `req.ip` reads from `X-Forwarded-For` only when `trust proxy`
// is set. The value tells Express how many proxy hops to peel back. The
// rate limiter, audit log, and per-user lockout all rely on `req.ip`
// being the *client* IP, not a proxy IP — get this wrong and a hostile
// client can spoof their IP via XFF (when trust is too generous), or
// every request gets rate-limited as one IP (when trust is too strict).
//
// Set `TRUST_PROXY` to match the deploy topology:
//   `0`        — no proxy in front. Direct exposure. Local dev default.
//   `1`        — single proxy (App Service alone, single load balancer).
//   `2`        — two hops (Azure Front Door → App Service is the most
//                common Viljetech production shape).
//   `loopback` — only trust 127.0.0.1 / ::1 (reverse proxy on the same host).
//   `<CIDR>`   — explicit CIDR allow-list, e.g. `10.0.0.0/8` for a
//                private network. Comma-separate multiple ranges.
//
// Default is `1` — matches the legacy behaviour. Production deploys
// behind Front Door MUST set `TRUST_PROXY=2`. See
// `docs/deploy/trust-proxy-topology.md` for the full reasoning.
export const TRUST_PROXY = (() => {
    const raw = (process.env.TRUST_PROXY ?? '1').trim();
    // Numeric form (`0`, `1`, `2`, ...) — Express expects a number, not a string.
    if (/^\d+$/.test(raw)) return Number(raw);
    // Named modes pass through as-is (`loopback`, `linklocal`, `uniquelocal`).
    // CIDR / IP lists also pass through; Express splits on comma.
    return raw;
})();

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

// ─── Operational toggles ───────────────────────────────────────────────
//
// All boolean-like flags use the same parser so values like `"true"`,
// `"TRUE"`, `"1"` all coerce to true; everything else (including the
// empty string) is false. Centralising here means a typo in the env
// (e.g. `JOBS_ENABLED=trueeee`) is treated the same way regardless of
// where in the code the flag is consumed.
const parseBool = (raw: string | undefined, defaultValue: boolean): boolean => {
    if (raw === undefined) return defaultValue;
    const v = raw.toLowerCase().trim();
    return v === 'true' || v === '1' || v === 'yes';
};

/**
 * `JOBS_ENABLED` — master switch for the cron registry. Off by default
 * in tests + smoke runs (so they don't fight the registered jobs); on
 * by default in dev / prod.
 */
export const JOBS_ENABLED = parseBool(process.env.JOBS_ENABLED, true);

/**
 * `EXPORT_WORKER_INLINE` — test seam. When true, the report-export
 * worker awaits the render synchronously instead of `setImmediate`-
 * dispatching it. Tests use this to assert on the final state without
 * timing fragility.
 */
export const EXPORT_WORKER_INLINE = parseBool(process.env.EXPORT_WORKER_INLINE, false);

// `PDF_ENGINE` and `PUPPETEER_EXECUTABLE_PATH` are intentionally read
// late (at the consumption site) rather than centralised here. Both
// are fully optional with default fallbacks, so there's no boot-time
// validation to gain. Late reading also keeps the test-mutation
// pattern (`process.env.PDF_ENGINE = 'pdfmake'`) working without
// `vi.resetModules`. See `BACKEND_AUDIT.md` P3-19 for rationale.

// ─── Email transport (BACKEND_AUDIT.md P0-1) ───────────────────────────
//
// `EMAIL_TRANSPORT` selects the outbound delivery flavour:
//   - `stub`    — dev/test default. Logs the dispatch; nothing leaves.
//   - `acs`     — Azure Communication Services Email REST.
//                 Requires `ACS_CONNECTION_STRING` + `ACS_FROM_ADDRESS`.
//   - `mailjet` — Mailjet v3.1 Send API. Requires `MAILJET_API_KEY`
//                 + `MAILJET_API_SECRET` + `MAILJET_FROM_ADDRESS`
//                 + `MAILJET_FROM_NAME`.
//
// Production must explicitly set this to `acs` or `mailjet`. Leaving
// it at the default `stub` in production would silently swallow every
// password-reset / leave-notification email — the stub transport
// downgrades to a `warn` log line under `NODE_ENV=production` so the
// misconfiguration is at least observable.

export const EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT ?? (NODE_ENV === 'production' ? 'stub' : 'stub');

export const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING ?? null;
export const ACS_FROM_ADDRESS = process.env.ACS_FROM_ADDRESS ?? null;

export const MAILJET_API_KEY = process.env.MAILJET_API_KEY ?? null;
export const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET ?? null;
export const MAILJET_FROM_ADDRESS = process.env.MAILJET_FROM_ADDRESS ?? null;
export const MAILJET_FROM_NAME = process.env.MAILJET_FROM_NAME ?? 'Viljetech';

// Boot-time sanity: when an explicit transport is selected, the
// matching credentials must be present. A typo'd ACS_CONNECTION_STRING
// would otherwise throw at the first send (which might be hours into
// the running process); fail at boot instead so the operator sees it
// during deploy.
if (EMAIL_TRANSPORT === 'acs') {
    if (!ACS_CONNECTION_STRING || !ACS_FROM_ADDRESS) {
        throw new Error(
            'EMAIL_TRANSPORT=acs but ACS_CONNECTION_STRING and/or ACS_FROM_ADDRESS is missing. ' +
                'See `.env.example` for the expected variables.'
        );
    }
} else if (EMAIL_TRANSPORT === 'mailjet') {
    if (!MAILJET_API_KEY || !MAILJET_API_SECRET || !MAILJET_FROM_ADDRESS) {
        throw new Error(
            'EMAIL_TRANSPORT=mailjet but one or more of MAILJET_API_KEY / MAILJET_API_SECRET / ' +
                'MAILJET_FROM_ADDRESS is missing. See `.env.example` for the expected variables.'
        );
    }
} else if (EMAIL_TRANSPORT !== 'stub') {
    throw new Error(`EMAIL_TRANSPORT="${EMAIL_TRANSPORT}" is unknown. Valid values: "stub", "acs", "mailjet".`);
}
