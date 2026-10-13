# Authentication & MFA — Backend

The **Auth** module owns the credentials lifecycle for the platform: login (with optional MFA second factor), refresh-token rotation with reuse detection, logout (single + all), password change, forgot/reset flow, MFA enrollment + verification + disable + backup-code regeneration, session management, and the **`authenticate` middleware** every other module mounts.

Three closely related concerns live elsewhere and are linked at the boundary:
- **User-record management** (deactivation, GDPR, profile fields, admin-triggered password reset trigger point) → [`user-management.md`](./user-management.md)
- **Permission catalog + role bundles** → `roles-rbac.md`
- **Notifications dispatched on auth events** (welcome email on user create, reset-link email) → notifications module

---

## Scope

| Surface | In scope | Notes |
|---|---|---|
| `POST /auth/login` (email + password, optional MFA challenge) | ✓ | |
| `POST /auth/refresh` (rotate refresh token) | ✓ | Reuse detection + chain revoke |
| `POST /auth/logout` / `/logout-all` | ✓ | Idempotent single + all-active |
| `POST /auth/change-password` | ✓ | Verify old, force `logout-all` |
| `POST /auth/forgot-password` / `/reset-password` | ✓ | Enumeration-guarded |
| `GET /auth/me` | ✓ | Identity + role bundle + session count + photo SAS URL |
| `GET /auth/sessions` / `POST /auth/sessions/:id/revoke` | ✓ | Active refresh-token rows |
| MFA setup init + confirm | ✓ | TOTP + backup codes; QR data URL |
| MFA verify (login challenge) | ✓ | TOTP OR backup-code; shares lockout budget |
| MFA disable + regenerate backup codes | ✓ | Requires password + TOTP |
| `authenticate` middleware (T1 status gate, Step-28 force-MFA gate) | ✓ | Mounted on every authed router |
| `requirePermission` / `requirePermissionOrSelf` middlewares | ✓ | Permission gates other modules consume |
| JWT key rotation (`kid` header) | ✓ | Graceful migration without forcing re-login |
| Admin-triggered password reset (`POST /users/:id/reset-password`) | Service entry point lives here | Route + actor wiring in [`user-management.md`](./user-management.md) |

---

## Token model

### Access token

Stateless JWT — **verified by signature only**, no DB lookup per request. TTL `JWT_EXPIRES_IN` (default 8h).

Payload ([`types/index.ts`](../../src/types/index.ts) `BaseJWTPayload`):
```ts
{ user_id, role, role_keys: string[], permissions: string[], iat, exp[, kid header] }
```

`permissions[]` is the resolved union from `(role_ids[].permissions ∪ extra_permissions)`. Baked at token-issue time. **A permission grant mid-session doesn't take effect until the next refresh.**

### Refresh token

JWT **plus** a DB row in `refresh_tokens`. Stateful — verified by signature AND a row lookup by `sha256Hex(token)`. TTL `JWT_REFRESH_EXPIRES_IN` (default 30d).

JWT payload: `BaseJWTPayload` + `{type: 'refresh', jti: <ulid>}`. The middleware refuses `type: 'refresh'` for access-token verification (defence-in-depth).

DB shape ([`refresh-token.model.ts`](../../src/models/refresh-token.model.ts)):
```ts
{
  _id, user_id, token_hash (SHA-256, unique),
  device_info, ip_address,
  expires_at,                       // TTL index expireAfterSeconds=0
  revoked_at, replaced_by_token_id, // for rotation + reuse detection
  created_at, updated_at
}
```

Indexes: `{user_id: 1}` (declared via `index: true`), `{user_id: 1, revoked_at: 1, created_at: 1}` (L6 — for the session cap query), TTL on `expires_at`.

**Only the hash is stored.** A DB leak can't replay the token; the plaintext only ever exists in the response body + the client.

### MFA-session token

Issued by `/auth/login` when the user has `mfa_enabled: true`. Short-lived JWT (5 min). Carries a `jti` that's **burned in a `mfa_session_jtis` collection** after a successful `/mfa/verify` (R10 replay protection — see below). NOT a refresh token; NOT useful for any other endpoint.

### JWT key rotation

[`utils/jwt.ts`](../../src/utils/jwt.ts) supports key rotation via a registry + a `kid` JOSE header:

- **Single-key mode (default)** — `JWT_SECRET` / `JWT_REFRESH_SECRET` env vars. Tokens have no `kid`.
- **Multi-key mode** — set `JWT_ACTIVE_KID` + populate `JWT_KEY_REGISTRY` (`Map<kid, secret>`). New tokens carry `kid` in the header; verifier reads the `kid` from the **un-trusted** header, looks up the registered secret, and verifies. Unknown kid → falls back to legacy `JWT_SECRET` (so a typo'd / forged kid can't escape).

Same shape for refresh keys via `JWT_REFRESH_ACTIVE_KID` + `JWT_REFRESH_KEY_REGISTRY`. **Graceful migration** — operators can rotate keys without forcing re-login because verification still accepts old-kid tokens until they expire.

MFA-session JWTs share the access-key registry (R2) so a kid rotation is also graceful for in-flight MFA challenges.

`verifyAccessToken` and `verifyRefreshToken` increment `jwt_verify_failures_total{kind}` on failure.

---

## Endpoints

[`routes/auth.routes.ts`](../../src/routes/auth.routes.ts). Almost every endpoint carries `authRateLimiter` (10/15min/IP per [`rate-limit.middleware.ts`](../../src/middlewares/rate-limit.middleware.ts)) on top of the global per-IP cap.

### Public

| Method | Path | Rate limit | Body |
|---|---|---|---|
| `POST` | `/auth/login` | `authRateLimiter` | `{email, password}` |
| `POST` | `/auth/refresh` | `authRateLimiter` | `{refresh_token}` |
| `POST` | `/auth/logout` | `authRateLimiter` (M5) | `{refresh_token}` |
| `POST` | `/auth/forgot-password` | `authRateLimiter` | `{email}` |
| `POST` | `/auth/reset-password` | `authRateLimiter` | `{token, new_password}` |
| `POST` | `/auth/mfa/verify` | `authRateLimiter` | `{mfa_session_token, code, is_backup_code}` |

**M5** — pre-M5 `/logout` fell through to the global 120/min/IP. An attacker hitting `/logout` with guessed refresh tokens shouldn't bypass the auth-tier budget; the cheap path is no excuse.

### Authenticated

| Method | Path | Rate limit | Notes |
|---|---|---|---|
| `POST` | `/auth/logout-all` | — | Revokes all active sessions for caller |
| `POST` | `/auth/change-password` | `authRateLimiter` | Body: `{old_password, new_password}` |
| `GET` | `/auth/me` | — | Returns identity + permissions + session_count + photo SAS |
| `GET` | `/auth/sessions` | — | Active refresh-token rows for caller |
| `POST` | `/auth/sessions/:id/revoke` | — | Caller-only |
| `POST` | `/auth/mfa/setup/init` | — | Generates secret + QR; secret stored ENCRYPTED |
| `POST` | `/auth/mfa/setup/confirm` | `authRateLimiter` | Body: `{code}` — verifies first TOTP, flips `mfa_enabled` |
| `POST` | `/auth/mfa/disable` | `authRateLimiter` | Body: `{password, code}` |
| `POST` | `/auth/mfa/backup-codes/regenerate` | `authRateLimiter` | Body: `{code}` |

---

## `authenticate` middleware

[`middlewares/auth.middleware.ts`](../../src/middlewares/auth.middleware.ts). Every authed router mounts `router.use(authenticate)`.

Flow:
1. Read `Authorization: Bearer <token>`. No header / bad shape → 401 `UNAUTHENTICATED`.
2. `verifyAccessToken(token)` — signature + expiry. Failures bubble as `jwt.TokenExpiredError` / `JsonWebTokenError`; the global error handler maps to 401 with `TOKEN_EXPIRED` or generic unauth.
3. **Refuse refresh / MFA-session tokens** here — defence-in-depth, even though signing secrets differ. If `payload.type` is set, reject as unauthenticated.
4. Store payload on `req.user`.
5. **T1 + Step-28 combined user-row read** — `loadAuthUserRow(payload)`:
   - `User.findById(payload.user_id).select('status mfa_enabled').lean()`.
   - **Missing user** → 401 (token's user_id no longer resolves; treat as forged).
   - **`status !== 'active'`** → 403 `ACCOUNT_DEACTIVATED` (T1 — closes the "JWT-outlives-deactivate" window; refresh tokens are revoked on deactivate but the access token lives 8h on signature alone).
6. **Step-28 admin-MFA gate** — `enforceMfaGate(req, payload, userRow)`. Three cheap short-circuits (caller isn't admin / method is read-only / path is exempt) before any settings read. If the gate doesn't short-circuit and `system_settings.security.require_mfa_for_admins` is true AND `userRow.mfa_enabled === false`, throw 403 `MFA_REQUIRED` with the remediation URL.

Read methods (`GET`, `HEAD`, `OPTIONS`) bypass the MFA gate so an admin without MFA can still see dashboards / their own profile. **Exempt paths** (matched **exactly**, not via `endsWith` — a future `/projects/:id/mfa/setup/init` would otherwise sneak past):
- `/mfa/setup/init`
- `/mfa/setup/confirm`

The cost on a cold install (flag off) is one indexed `findById` per authed request — same as the T1 status check needs anyway.

### `isCallerAdmin` — dual-signal check

```ts
const isCallerAdmin = (payload) =>
  payload.role === 'admin' || (payload.role_keys ?? []).includes('admin');
```

Step-47 dual-signal: tokens issued before Step-47 deploy don't carry `role_keys`; tokens after the deploy populate both. Either signal counts.

### `requirePermission(...perms)` and `requirePermissionOrSelf(perm, {paramName})`

Factory middlewares. Empty `requiredPermissions` throws at module-load (surface typos immediately). Allow if any of:
- caller holds `system.admin` wildcard
- caller is admin via `isCallerAdmin` (legacy + role_keys signal)
- caller holds any one of the listed permissions (OR semantics)

`requirePermissionOrSelf` adds an extra carve-out: `req.params[paramName] === req.user.user_id` (self path) passes through without needing the permission. Used by `PATCH /users/:id` (M2 — see [`user-management.md`](./user-management.md)).

### `callerHasPermission(req, perm)` — inline probe

Boolean version of the gate. Used by list controllers that need to silently scrub privileged query params (e.g. `show_deleted=true`) when a non-permitted caller sends them, instead of rejecting the whole request.

---

## Login flow

[`services/auth.service.ts:login`](../../src/services/auth.service.ts).

1. **Normalise email** — `email.trim().toLowerCase()` (R7 defence-in-depth on top of the validator's `lowercase: true`).
2. **Lookup user** — `User.findOne({email}).select('+password_hash +failed_login_attempts +locked_until +mfa_enabled')`. T8 fields are `select: false` by default; explicit opt-in here.
3. **Unknown email** → run a **timing-equalising `bcrypt.compare`** against a fixed dummy hash so the wall time approximates a real wrong-password branch. Throw `INVALID_CREDENTIALS` (401, generic — `INVALID_CREDENTIALS` is the only code for "email not found OR password wrong" per API_Contract §2.2 enumeration guard).
4. **Account locked** — if `locked_until > now`, throw `ACCOUNT_LOCKED` (423).
5. **Account deactivated** — if `status !== 'active'`, throw `ACCOUNT_DEACTIVATED` (403). Distinct from `INVALID_CREDENTIALS` because the attacker already had to authenticate to learn this — no new enumeration signal.
6. **Verify password** — `verifyPassword(plaintext, hash)` (bcrypt).
7. **Wrong password** → `applyFailedLoginAttempt(user)`:
   - Increment `failed_login_attempts`.
   - Stamp `last_failed_login_at`.
   - If next count ≥ threshold (`settings.security.failed_login_threshold` or compile-time `MAX_LOGIN_ATTEMPTS`):
     - Set `locked_until = now + lockout_duration_minutes` (or default `LOGIN_LOCKOUT_MS`).
     - Reset counter to 0 (next unlock-window starts fresh).
   - Throw `INVALID_CREDENTIALS`.
8. **MFA branch** — if `user.mfa_enabled`:
   - **DO NOT clear counters yet** — TOTP brute-force on `/mfa/verify` shares this lockout budget.
   - `issueMfaSession(user_id.toString())` — 5-min JWT with a `jti`.
   - Return `{mfa_required: true, mfa_session_token, mfa_session_expires_at}`.
9. **Success path** — `clearLoginCounters(user._id)`:
   - Zero `failed_login_attempts`, `last_failed_login_at`, `locked_until`.
   - Stamp `last_login_at = new Date()`.
10. **`resolveAuthContext(user._id, user.role)`** — load role bundle + permissions. Self-heals legacy users whose `role_ids` is empty by back-assigning the system role matching their legacy `role` string. Falls back to empty set if both fail (`requirePermission` then 403s every privileged route — correct fail-closed).
11. **`issueTokenPair({user_id, role, role_keys, permissions, device_info, ip_address})`**:
    - Create access JWT (`createAccessToken(payload)`).
    - Create refresh JWT (`createRefreshToken(payload)` — includes ULID `jti`).
    - Insert `RefreshToken` row with `token_hash = sha256Hex(refresh.token)`.
    - **`enforceSessionCap(user_id, freshRowId)`** — post-insert (R5 race fix).
    - Bump `refresh_tokens_issued_total{reason: 'login'}` counter.
12. Return `{access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, user: {id, role, full_name}}`.

### Per-user active-session cap (R5 post-insert)

[`enforceSessionCap`](../../src/services/auth.service.ts). The pre-R5 pre-insert pattern was racy: two simultaneous logins could both observe `count = 19`, both pass the `< MAX` short-circuit, both insert, end up at 21.

Post-insert:
1. Fresh row already created (caller passes `freshRowId`).
2. Count active sessions excluding `freshRowId`.
3. If count > `MAX_ACTIVE_SESSIONS_PER_USER` (default 20):
   - Evict the **oldest** `count - MAX` rows by `created_at` (mirrors GitHub/Google "X devices have access" UX where the most-recent-used device is preserved).
   - The fresh row is **never** an eviction candidate (`_id: {$ne: freshRowId}`).
4. **Best-effort** — a Mongo blip mid-eviction logs `SESSION_CAP_SWEEP_FAILED` at warn but does NOT fail the login. Next login retries the sweep.

Index `{user_id: 1, revoked_at: 1, created_at: 1}` (L6) makes this a pure index scan.

Refresh-rotation skips this — that flow already revokes the prior row, so the count is balanced.

---

## Refresh flow

[`services/auth.service.ts:refreshTokens`](../../src/services/auth.service.ts).

1. `verifyRefreshToken(input.refresh_token)` — JWT signature + expiry. `jwt.JsonWebTokenError` surfaces via the global handler; other failures map to 401.
2. `tokenHash = sha256Hex(input.refresh_token)`; `RefreshToken.findOne({token_hash})`.
3. **Token unknown** → 401 `UNAUTHENTICATED` "Invalid refresh token".
4. **Reuse detected** — if `row.revoked_at` AND `row.replaced_by_token_id` (token has been rotated, but somebody just presented it again):
   - **Revoke the ENTIRE chain** — `RefreshToken.updateMany({user_id, revoked_at: null}, {revoked_at: new Date()})`.
   - Throw 401 `TOKEN_REUSE_DETECTED`. **All other devices die instantly.** Treat as theft.
5. **Already revoked (but not replaced)** → 401 "Refresh token revoked".
6. **Expired** → 401 `TOKEN_EXPIRED`.
7. **User check** — `User.findById(payload.user_id).select('status role')`. If missing or `status !== 'active'`, revoke the entire chain and throw 403 `ACCOUNT_DEACTIVATED`.
8. **Atomic revoke + concurrent reuse check**:
   - `updateOne({_id: row._id, revoked_at: null}, {$set: {revoked_at: new Date()}})`.
   - If `modifiedCount === 0` (lost the race), **treat as reuse** — revoke the whole chain, throw `TOKEN_REUSE_DETECTED`.
9. **Re-resolve permissions** — `resolveAuthContext(row.user_id, user.role)`. This means a permission grant during the access-token's lifetime takes effect on the next refresh **without forcing the user to log in again**.
10. `issueTokenPair({..., replaces_token_id: row._id})`:
    - Same flow as login, but: skip the session cap (the predecessor is being revoked).
    - **Back-link** — `updateOne(row._id, {$set: {replaced_by_token_id: newRow._id}})` so the chain is traceable from any historical row.
    - Bump `refresh_tokens_issued_total{reason: 'rotation'}`.
11. Return `{access_token, refresh_token, ...expires_at}` — no `user` object (caller already knows).

The rotation is **single-use per token generation**. Concurrent `/refresh` calls with the same token: one wins the atomic update, the other sees `modifiedCount === 0` and trips the reuse path.

---

## Logout

`POST /auth/logout` ([`logout`](../../src/services/auth.service.ts)) — `updateOne({token_hash, revoked_at: null}, {$set: {revoked_at: new Date()}})`. **Idempotent**: unknown / already-revoked tokens succeed silently.

`POST /auth/logout-all` — `updateMany({user_id, revoked_at: null}, {$set: {revoked_at: new Date()}})`. Used by:
- `/auth/change-password` (after a successful change)
- `/auth/reset-password` (after consume)
- `user.service.deactivateUser` (cascade)
- `user-gdpr.service.eraseUserData` (anonymisation step 1)

---

## Change password

[`services/auth.service.ts:changePassword`](../../src/services/auth.service.ts).

1. Load user with `+password_hash`.
2. `verifyPassword(input.old_password, user.password_hash)` — wrong → `INVALID_CREDENTIALS` "Old password is incorrect".
3. `hashPassword(input.new_password)` (bcrypt; new password policy enforced upstream by the Zod validator).
4. `updateOne({_id}, {$set: {password_hash, last_password_changed_at: new Date()}})`.
5. `logoutAll(user._id)` — revoke every active refresh token for this user. The current session's access token lives until natural expiry, but the next `/refresh` will 401. The FE typically signs the user out everywhere immediately too.
6. Audit `AUTH_PASSWORD_CHANGE`.

The Zod schema (`changePasswordBodySchema`) requires `new_password !== old_password` and enforces the password policy: `PASSWORD_MIN_LENGTH ≤ length ≤ PASSWORD_MAX_LENGTH` + upper + lower + digit + special (`PASSWORD_REGEX`). Violations surface as `VALIDATION_ERROR`.

---

## Forgot / reset password

[`services/password-reset.service.ts`](../../src/services/password-reset.service.ts). `password_reset_tokens` collection ([`password-reset-token.model.ts`](../../src/models/password-reset-token.model.ts)) — `token_hash` (SHA-256, unique), `expires_at` (TTL index), `used_at`.

### `POST /auth/forgot-password`

1. **Normalise email** (R7).
2. Lookup user.
3. **Unknown / deactivated user** — **silent no-op** with light decoy work (`randomBytes(RESET_TOKEN_BYTES)` discarded) so the timing of the silent branch approximates the success branch. **No 404. No 403.** Same generic 200 response either way — `{message: "If this email is registered, a reset link has been sent."}` (enumeration guard, API_Contract §2.5).
4. **Active user**:
   - **Invalidate older unused tokens** — `updateMany({user_id, used_at: null}, {used_at: new Date()})`. Only the LATEST link works (standard UX + mitigates phished-but-unused links).
   - Mint a new opaque token — `base64url(randomBytes(RESET_TOKEN_BYTES))` (32 bytes → ~43 chars).
   - Store `sha256Hex(token)`; plaintext goes ONLY into the email body.
   - TTL — `system_settings.security.password_reset_ttl_minutes` (Step 33), falling back to compile-time `RESET_TOKEN_TTL_MS` (1h) during the fresh-install bootstrap window.
   - Send email via `sendPasswordResetEmail({to, full_name, token})`.

### `POST /auth/reset-password`

1. `tokenHash = sha256Hex(input.token)`; lookup.
2. Three failure modes return the **same generic message** "Reset link is invalid or expired" with `VALIDATION_ERROR`:
   - Token not found
   - Token already used (`used_at != null`)
   - Token expired (`expires_at <= now`)
3. Load user. Missing → same generic message.
4. **Deactivated user** → 403 `ACCOUNT_DEACTIVATED` "Account is deactivated" — explicit, not silent. A deactivated user mustn't silently regain access through a stale reset link.
5. **Atomically mark token used** — `updateOne({_id, used_at: null}, {$set: {used_at: new Date()}})`. If `modifiedCount === 0` (lost the race), throw the generic error.
6. `hashPassword(input.new_password)`; update user with the new hash + `last_password_changed_at` + **clear lockout state** (`failed_login_attempts: 0, last_failed_login_at: null, locked_until: null` — user just proved control of the inbox).
7. `logoutAll(user._id)` — every active session revoked (plan §7.2).
8. Audit `AUTH_PASSWORD_RESET` with the **user as actor** (the reset link proved inbox control even though no JWT was used).

### Admin-triggered (`POST /users/:id/reset-password`)

`adminInitiatePasswordReset(targetUserId, audit)` — same mechanics as `requestPasswordReset` BUT:

| Difference | Why |
|---|---|
| **No enumeration silence** — surfaces `USER_NOT_FOUND` (404) | The admin already knows the user_id (it's in the URL); 404 here tells the operator their input was wrong |
| **Deactivated → 403, not silent** | Operator error — they should reactivate first; surface so they see the issue instead of wondering why no email arrived |
| **Audit row is `AUTH_ADMIN_PASSWORD_RESET` with admin as actor** | M24 — `target_email` removed; resolves via target.id (gated by `USER_READ`, separate from `AUDIT_LOG_READ`) |
| **No link in response** | Admin should trigger but not see the secret |

The downstream `AUTH_PASSWORD_RESET` row (when the user consumes the link) records the user as actor — the two rows together tell the "admin asked, user consumed" story.

---

## `GET /auth/me`

[`services/auth.service.ts:getMe`](../../src/services/auth.service.ts). Fresh DB read every call — status / MFA toggles up-to-date.

Returns:
```ts
{
  id, email, full_name, role, status, timezone, mfa_enabled,
  profile_photo_url,    // freshly-minted SAS URL or null
  session_count,        // active refresh tokens — null on read failure
  role_keys,            // server-fresh; FE compares against JWT for drift
  permissions           // server-fresh union (role bundle ∪ extra_permissions)
}
```

**`session_count`** is best-effort: a transient `RefreshToken.countDocuments` failure logs `SESSION_COUNT_READ_FAILED` and surfaces `null` (FE renders a neutral placeholder instead of "0 active sessions" — which would lie about the user's state).

**`profile_photo_url`** uses the same SAS lifetime as `system_settings.uploads.sas_token_ttl_minutes`. The FE re-fetches `/auth/me` whenever it refreshes the access token, so the URL never expires before the user notices.

**`permissions` is server-fresh** — the FE compares against the JWT-encoded set to detect drift; on mismatch fires `rotateAccessToken()` so the JWT picks up the new bundle without a re-login (BUG-006 — see FE doc).

---

## Sessions (Step 27)

A "session" maps **one-to-one to an active `refresh_tokens` row**. Rotation already invalidates predecessors (`replaced_by_token_id` + `revoked_at`), so the active set naturally has at most one row per logical device-session — no chain-walking required.

### `GET /auth/sessions`

Caller's active rows. Sorted newest-first. **No pagination** — a single user typically has < 10 active devices; admin-list-other-user's-sessions is intentionally not exposed (use the audit log filtered on `auth.session_*` actions instead).

`activeSessionFilter(user_id)` = `{user_id, revoked_at: null, expires_at: {$gt: new Date()}}`. Shared with `getMe`'s `session_count` so the two stay in lock-step.

Per-row public shape: `{id, device_info, ip_address, last_used_at, expires_at}`. **`last_used_at` is derived from `created_at`** of the un-revoked row in each chain — every rotation creates a new row with a fresh `created_at`, so the un-revoked row's `created_at` IS "when this session was last refreshed". For a session that's only been logged in (no refresh yet), `created_at` equals login time.

### `POST /auth/sessions/:id/revoke`

[`services/auth.service.ts:revokeSession`](../../src/services/auth.service.ts). **Atomic + idempotent**:

1. `findOneAndUpdate({_id: session_id, user_id, revoked_at: null}, {$set: {revoked_at: new Date()}}, {new: true})`.
2. **Won the write** → audit `AUTH_SESSION_REVOKE`, return `{revoked: true, id}`.
3. **Lost the atomic update** — re-read `findOne({_id, user_id})`:
   - **Not found** → 404 `SESSION_NOT_FOUND`. Same code for unknown id AND cross-user id (existence-leak guard).
   - **Found (already revoked)** → idempotent success, no second audit row.

Concurrent double-click: only one wins the audit row. Same pattern as the rotation's atomic guard.

---

## MFA

[`services/mfa.service.ts`](../../src/services/mfa.service.ts). TOTP (RFC 6238) + 10 single-use backup codes.

### Setup init (`POST /auth/mfa/setup/init`)

1. Load user. 404 if missing.
2. **Refuse if already enabled** → 409 `DUPLICATE_RESOURCE` "MFA is already enabled. Disable it first to re-enroll."
3. `generateTotpSecret()` (base32, 20 bytes / 160 bits).
4. `buildOtpAuthUrl(user.email, secret)` — `otpauth://totp/...`.
5. `generateQrDataUrl(otpauth)` — base64 PNG.
6. **Encrypt the secret** — `encryptSecret(secret)` (AES-256-GCM via `MFA_ENCRYPTION_KEY`).
7. **Persist** the encrypted (unconfirmed) secret on the user. `mfa_enabled` stays false; an abandoned enrollment is safe because the stored secret is never consulted until `mfa_enabled` flips.
8. Return `{otpauth_url, secret_base32, qr_data_url}`. **The FE shows the QR for the user to scan; the base32 secret is the manual-entry fallback.**

### Setup confirm (`POST /auth/mfa/setup/confirm`)

1. Load user with `+mfa_secret_encrypted +mfa_backup_codes_hashed`.
2. Already enabled → 409.
3. No enrollment in progress (`mfa_secret_encrypted` is null) → 400 `MFA_ENROLLMENT_NOT_FOUND`.
4. `decryptSecret(user.mfa_secret_encrypted)`; `verifyTotp(input.code, secret)` — wrong → 400 `INVALID_MFA_CODE`.
5. `generateBackupCodes()` — 10 plaintext codes + their hashes.
6. Flip `mfa_enabled: true`, store `mfa_backup_codes_hashed`.
7. Audit `AUTH_MFA_ENABLE`.
8. **Return the plaintext backup codes** — `{mfa_enabled: true, backup_codes: [...]}`. The user MUST save them now; the BE never persists plaintext.

### Verify (`POST /auth/mfa/verify`)

Public endpoint — no access token. The `mfa_session_token` travels in the body and is the only credential.

1. `verifyMfaSession(input.mfa_session_token)`:
   - `TokenExpiredError` → 401 `TOKEN_EXPIRED` "MFA session expired, please login again".
   - Other → 401 `UNAUTHENTICATED` "Invalid MFA session".
2. Load user with `+password_hash +mfa_secret_encrypted +mfa_backup_codes_hashed +failed_login_attempts +locked_until`. Missing → 401 (same generic).
3. **Defence-in-depth re-checks** between password and MFA:
   - `locked_until > now` → 423 `ACCOUNT_LOCKED`.
   - `status !== 'active'` → 403 `ACCOUNT_DEACTIVATED`.
   - `!mfa_enabled || !mfa_secret_encrypted` → 401 (MFA was turned off between `/login` and `/verify` — force the client back through login).
4. **Verify code**:
   - `is_backup_code: true` → `findMatchingBackupCodeIndex(input.code, hashes)`. `success = index >= 0`.
   - `is_backup_code: false` → `verifyTotp(input.code, decryptSecret(...))`.
5. **Wrong code** → `applyFailedLoginAttempt(user)` (shares the password lockout budget — 5 bad codes flip the lockout, same threshold). Throw 400 `INVALID_MFA_CODE`.
6. **Backup code used** → **single-use semantics**: remove the matched hash so the same code can never be reused. `updateOne({_id}, {$set: {mfa_backup_codes_hashed: remaining}})`.
7. **R10 burn the JTI** — `consumeMfaSessionJti(payload.jti, payload.exp * 1000)`:
   - Inserts a row in `mfa_session_jtis` keyed by `jti`. Replay (concurrent or sequential) throws `MfaSessionReplayError` → 401 generic.
   - Run AFTER the TOTP/backup check so a typo doesn't burn the session and force a re-login.
8. `completeLoginAfterMfa(user, device_info, ip_address)`:
   - `clearLoginCounters(user._id)`.
   - `resolveAuthContext + issueTokenPair`.
   - Return the same `LoginTokenResult` shape as a non-MFA login.

### Disable (`POST /auth/mfa/disable`)

Requires `{password, code}` — BOTH the password AND a current TOTP. Wipes `mfa_secret_encrypted` + `mfa_backup_codes_hashed` + `mfa_enabled`. Audit `AUTH_MFA_DISABLE`.

### Regenerate backup codes (`POST /auth/mfa/backup-codes/regenerate`)

Requires a current TOTP. Generates 10 fresh codes; replaces `mfa_backup_codes_hashed`. Returns plaintext. Audit `AUTH_MFA_REGENERATE_BACKUP_CODES` with `metadata: {backup_codes_count: 10}`.

---

## Brute-force protection

Counters on the user document (`select: false`):
- `failed_login_attempts` — current streak
- `last_failed_login_at` — last bad attempt
- `locked_until` — lockout end timestamp (null = unlocked)

`applyFailedLoginAttempt(user)` is called from BOTH `/login` (wrong password) AND `/mfa/verify` (wrong TOTP / backup code) — the two share the same budget.

Threshold + duration are read from `system_settings.security` (Step 33): `failed_login_threshold` (default `MAX_LOGIN_ATTEMPTS = 5`), `lockout_duration_minutes` (default 15). Operators can tune via `PATCH /settings`.

`clearLoginCounters(user_id)` is called on successful login completion (after MFA if applicable). Reset to 0 + stamp `last_login_at`. Reset is also part of `resetPassword` — proving inbox control clears the lock.

---

## Audit actions produced

| Action | When |
|---|---|
| `AUTH_PASSWORD_CHANGE` | `POST /auth/change-password` |
| `AUTH_PASSWORD_RESET` | `POST /auth/reset-password` (user-initiated consume) — actor is the user |
| `AUTH_ADMIN_PASSWORD_RESET` | `POST /users/:id/reset-password` — actor is the admin |
| `AUTH_MFA_ENABLE` | `POST /auth/mfa/setup/confirm` |
| `AUTH_MFA_DISABLE` | `POST /auth/mfa/disable` |
| `AUTH_MFA_REGENERATE_BACKUP_CODES` | `POST /auth/mfa/backup-codes/regenerate` |
| `AUTH_SESSION_REVOKE` | `POST /auth/sessions/:id/revoke` — metadata includes `{user_id, device_info, ip_address}` |

`POST /auth/login` does NOT emit a per-success audit row by design — would be one row per minute under normal traffic and drown the audit log. Failed logins likewise (the counters carry the signal). Refresh rotation has no audit row either.

`AUTH_PASSWORD_RESET` is distinctive: the actor is the **user the token belongs to**, not the unauthenticated caller. The controller passes a base context with `actor_id: null, actor_role: 'unauthenticated'`; the service rebuilds the actor inside the audit call once the token is verified.

---

## Error codes produced

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/bad Authorization header; refresh/mfa-session token used as access; refresh-token row missing |
| `INVALID_CREDENTIALS` | 401 | Wrong email OR wrong password OR wrong old_password (generic) |
| `ACCOUNT_LOCKED` | 423 | Locked-until > now on login or MFA verify |
| `ACCOUNT_DEACTIVATED` | 403 | Status not active — login, refresh, or any authenticated route after T1 |
| `TOKEN_EXPIRED` | 401 | Refresh token JWT expired; MFA session JWT expired |
| `TOKEN_REUSE_DETECTED` | 401 | Refresh-token reuse — entire chain revoked |
| `MFA_REQUIRED` | 403 | Admin without MFA hitting a non-read non-exempt route under Step-28 gate |
| `INVALID_MFA_CODE` | 400 | TOTP or backup-code mismatch |
| `MFA_NOT_ENABLED` | 400 | Disable / regenerate when MFA wasn't on |
| `MFA_ENROLLMENT_NOT_FOUND` | 400 | Confirm before init |
| `DUPLICATE_RESOURCE` | 409 | `setup/init` when MFA is already enabled |
| `SESSION_NOT_FOUND` | 404 | Revoke unknown or cross-user session id |
| `VALIDATION_ERROR` | 400 | Password policy violation; new == old; bad reset token (generic) |
| `PASSWORD_POLICY_VIOLATION` | 422 | Service-layer policy check (`assertPasswordPolicy` — used by user-create only) |
| `USER_NOT_FOUND` | 404 | Admin-triggered reset for unknown user; change-password for missing user |

---

## End-to-end flows

### Login (no MFA)

1. POST `/auth/login` with `{email, password}`.
2. Validator lowercases email; service re-lowercases (R7 defence).
3. User found, not locked, active, password verifies.
4. `mfa_enabled === false` — clear counters, stamp `last_login_at`.
5. `resolveAuthContext` builds role_keys + permissions.
6. `issueTokenPair` creates access + refresh, inserts `RefreshToken` row, runs `enforceSessionCap` post-insert.
7. Bump `refresh_tokens_issued_total{reason: 'login'}`.
8. Response: `{access_token, refresh_token, user: {id, role, full_name}, ...expires_at}`.

### Login with MFA

1. Same up through password verify.
2. `mfa_enabled === true`. Counters NOT cleared yet.
3. Mint MFA-session JWT (5 min, `jti`).
4. Response: `{mfa_required: true, mfa_session_token, mfa_session_expires_at}`.
5. FE navigates to `/login/mfa`, holds the session token in router state (mirrored to sessionStorage per M46).
6. User enters TOTP. POST `/auth/mfa/verify` with `{mfa_session_token, code, is_backup_code: false}`.
7. Verify session JWT → load user with secrets → defence-in-depth re-checks → `verifyTotp`.
8. **Burn the JTI** — `consumeMfaSessionJti`. Replay throws `MfaSessionReplayError` → 401.
9. `completeLoginAfterMfa` — clear counters, issue token pair, return full login result.

### MFA brute-force flow

1. User enters wrong TOTP. `applyFailedLoginAttempt` runs — `failed_login_attempts` increments shared with password attempts.
2. After 5 bad attempts (across both endpoints), `locked_until = now + 15min`. Counter resets to 0.
3. User retries `/mfa/verify` while locked → 423 `ACCOUNT_LOCKED` from the defence-in-depth check.
4. Same code path for `/login` retries.

### Refresh-token reuse (theft scenario)

1. Attacker steals a refresh token (e.g. via XSS — V2 cookie migration mitigates this; today's localStorage exposure is documented).
2. Attacker calls `/auth/refresh`. Wins the race — gets a fresh access + refresh pair. Old row marked `revoked_at`, `replaced_by_token_id` populated.
3. Legitimate user's client tries to refresh with the SAME old token (it didn't know about the attacker's rotation).
4. BE finds the row, sees `revoked_at != null AND replaced_by_token_id != null` — **reuse detected**.
5. `updateMany({user_id, revoked_at: null}, {$set: {revoked_at: new Date()}})` — every session for this user dies, including the attacker's freshly-minted pair.
6. Throw 401 `TOKEN_REUSE_DETECTED`.
7. Both attacker and legitimate user are kicked out. User must log in again; the attacker has nothing useful.

### Concurrent refresh-token rotation

1. Two parallel `/refresh` calls arrive with the same token (FE bug or network retry).
2. Atomic update on the first: `findOneAndUpdate({_id, revoked_at: null}, ...)` — wins.
3. Atomic update on the second: predicate misses (the row's `revoked_at` is now non-null). `modifiedCount === 0`.
4. Second caller falls into the lost-race branch: revoke whole chain, throw `TOKEN_REUSE_DETECTED`.

This is conservative — it kills both sessions on what was likely a benign retry. The FE coalesces 401s behind a single in-flight rotation promise (`rotationPromise`) to avoid this. See FE doc.

### Forgot password (enumeration guard)

1. POST `/auth/forgot-password` with `{email: 'unknown@example.com'}`.
2. Service normalises email, looks up. User missing.
3. **Light decoy work** — `randomBytes(RESET_TOKEN_BYTES)` discarded. No token written. No email sent.
4. Response: 200 `{message: "If this email is registered, a reset link has been sent."}`.

Attacker can't distinguish unknown emails from known ones by either response shape OR timing (decoy work + DB indices). The same email POSTed with a known address gets the same response.

### Admin without MFA hits a write endpoint (Step-28)

1. Admin (legacy or Step-47) signs in. Holds `system.admin` permission. `mfa_enabled === false`.
2. `system_settings.security.require_mfa_for_admins === true`.
3. Admin POSTs `/api/v1/projects` (write).
4. `authenticate` runs `loadAuthUserRow` (cheap — required by T1 anyway).
5. `enforceMfaGate` short-circuit checks: caller IS admin, method NOT read-only, path NOT in exempt set.
6. Settings read confirms `require_mfa_for_admins`. `userRow.mfa_enabled === false`.
7. Throw 403 `MFA_REQUIRED` "Admins must enable MFA before performing this action — visit /auth/mfa/setup/init to enroll."
8. Admin navigates to `/auth/mfa/setup/init` (EXEMPT — same auth gate passes through). Enrolls.
9. Once `mfa_enabled === true`, every subsequent write passes the gate.

The exempt set is EXACT match, not `endsWith` — a future `/projects/:id/mfa/setup/init` route would NOT silently bypass the gate.

---

## Gotchas

| # | Behaviour | Why |
|---|---|---|
| 1 | Access tokens are stateless — verified by signature only, no DB lookup per request | Hot-path performance; the T1 status check is a separate read |
| 2 | T1 user-row read runs on **every** authenticated request — closes the "JWT outlives deactivate" window | Without it, a just-deactivated user could keep mutating for ≤ 8h |
| 3 | T1 + Step-28 user reads are **coalesced** into one indexed `findById` per request | Both gates need the same row; query once |
| 4 | Refresh tokens are stored as **SHA-256 hash** | DB leak can't replay; plaintext only ever exists in response body + client |
| 5 | Refresh-token reuse triggers **whole-chain revocation** | Theft response; every device dies, attacker's freshly-minted pair included |
| 6 | Concurrent `/refresh` with the same token = reuse path for the loser | Atomic `findOneAndUpdate` ensures exactly one winner; FE coalesces to avoid the loss |
| 7 | Per-user session cap (default 20) is enforced **post-insert** (R5) | Pre-insert pattern was racy under concurrent logins |
| 8 | Session-cap eviction always preserves the fresh row via `_id: $ne` | Concurrent logins each protect their own freshly minted row |
| 9 | Refresh-rotation **re-resolves permissions** server-side | A permission grant takes effect on the next access-token cycle without forcing re-login |
| 10 | Unknown email on `/login` runs a **timing-equalising bcrypt compare** against a dummy hash | Prevents email enumeration via timing |
| 11 | `INVALID_CREDENTIALS` is used for unknown email AND wrong password | Enumeration guard — single generic error |
| 12 | `ACCOUNT_LOCKED` and `ACCOUNT_DEACTIVATED` are distinct codes | The attacker already authenticated to learn this signal; no new enumeration vector |
| 13 | MFA brute-force shares the password lockout budget | Wrong TOTP on `/mfa/verify` increments `failed_login_attempts` same as a wrong password |
| 14 | Login counters are **NOT cleared** until after MFA verify succeeds | TOTP brute-force must remain subject to the same lockout |
| 15 | MFA-session JTI is **burned AFTER successful verify** (R10) | A typo doesn't burn the session and force a re-login |
| 16 | Backup codes are single-use — the matched hash is removed from `mfa_backup_codes_hashed` on use | One-time-use by design |
| 17 | MFA secret stored AES-256-GCM encrypted (`MFA_ENCRYPTION_KEY`) | Even a DB leak can't reconstruct TOTPs without the key |
| 18 | MFA setup persists the secret BEFORE `mfa_enabled` flips | Abandoned enrolment is safe — the stored secret is never consulted until enabled |
| 19 | Step-28 admin-MFA gate uses **EXACT** path match for exempt set | `endsWith` would silently exempt a hypothetical `/projects/:id/mfa/setup/init` |
| 20 | Step-28 gate bypasses read methods (`GET`/`HEAD`/`OPTIONS`) | An MFA-less admin can still see dashboards / their own profile |
| 21 | `isCallerAdmin` reads both legacy `role` AND `role_keys[]` | Step-47 dual-signal; pre-Step-47 tokens still work |
| 22 | `requirePermission(empty)` throws at module-load, not per-request | Surface typos immediately |
| 23 | `/auth/forgot-password` is **silent + decoy work** on unknown / deactivated user | Enumeration guard with timing approximation |
| 24 | Reset-token consume is **atomic** (`updateOne({_id, used_at: null}, ...)`) | Concurrent consume of the same link returns the generic error to the loser |
| 25 | Successful password reset **clears lockout state** | User proved inbox control |
| 26 | Admin-triggered reset surfaces specific errors (`USER_NOT_FOUND` / `ACCOUNT_DEACTIVATED`) instead of silent 200 | Admin already knows the target; operator-facing error |
| 27 | `/auth/me` `session_count` is best-effort — returns `null` on read failure | Don't lie about "0 sessions" if the count read 500s |
| 28 | `/auth/me` `permissions` is server-fresh — used by FE to detect JWT drift | A perm grant mid-session triggers an FE rotation via `/auth/refresh` |
| 29 | Sessions list is **caller-only**, no pagination, no admin-list-other-user surface | Audit log filtered on `auth.session_*` is the cross-user view |
| 30 | Revoke session is **atomic + idempotent**; same code for unknown id and cross-user id | Existence-leak guard |
| 31 | JWT supports key rotation via `kid` header + registry, graceful fallback to legacy `JWT_SECRET` | Operators can rotate keys without forcing re-login |
| 32 | Password policy is enforced at **Zod schema** for change/reset; at **service** for user-create (`assertPasswordPolicy`) | Schema cares about login-payload shape (any non-empty password); creates need policy-passing |
| 33 | `AUTH_PASSWORD_RESET` audit row tags the **user** as actor even though no JWT was used | Reset link proves inbox control |
| 34 | Login / refresh do NOT emit audit rows | Would drown the audit log under normal traffic; failed-login counters carry the security signal |
| 35 | Logout is **idempotent** — already-revoked / unknown tokens return success | FE can fire logout fire-and-forget without retry logic |
