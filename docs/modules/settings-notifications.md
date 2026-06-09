# Settings & Notifications — Backend

Three sub-modules paired here because they share the dispatch substrate every business write reaches through:

1. **Settings** — singleton `system_settings` doc + admin-only PATCH + role-redacted reads + dedicated `/settings/slack` surface (J1 AES-encrypted bot token).
2. **Notifications** — owner-scoped in-app inbox + the `notification-dispatcher` that fans every business event out to in-app + email + Slack DM + push, never-throwing.
3. **Slack subsystem** — inbound webhooks (signature-verified, raw-body capture before parsers), outbound `chat.postMessage`/`chat.update` (best-effort, non-throwing), Slack-user → Viljetech-user resolver with `users.info` email-match fallback.
4. **Push** — Web Push subscription registry + VAPID dispatch + endpoint allowlist (SSRF defense).

Cross-references:
- [`auth-identity.md`](./auth-identity.md) — `requirePermission` gates writes; `require_mfa_for_admins` setting (Step 28).
- [`audit-compliance.md`](./audit-compliance.md) — every settings mutation + Slack `test-message` + push subscribe/unsubscribe audits.
- Every prior module — they call `notifyXxx(...)` helpers; the dispatcher fan-out is one-stop.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Settings** | `GET /settings/public`, `GET /settings`, `PATCH /settings` | Singleton; role-redacted reads; deep-merge PATCH |
| **Slack settings** | `GET /settings/slack`, `PATCH /settings/slack`, `POST /settings/slack/test-message` | J1 AES-GCM at rest; redacted to `has_bot_token` |
| **Slack webhooks** | `POST /slack/interactive`, `POST /slack/commands/:command` | HMAC-SHA256 signature; raw-body capture |
| **Notifications** | `GET /notifications`, `/unread-count`, `POST /:id/read`, `/read-all`, `DELETE /:id` | Owner-scoped, anti-enumeration 404 |
| **Push** | `POST /push/subscribe`, `POST /push/unsubscribe` (+ legacy `DELETE /push/subscribe` alias) | M21 — POST-canonical; VAPID public key NOT exposed (FE-bundled) |
| **Crons** | Day-of-week timesheet reminder + report subscriptions | Documented in their parent modules |

---

## Roles & permissions

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /settings/public` | none — anonymous | Login page reads branding |
| `GET /settings` | authenticated | Non-admin gets `ADMIN_ONLY_SECTIONS` stripped: `security`, `email`, `slack` |
| `PATCH /settings` | `settings.write` | Admin |
| `GET /settings/slack`, `PATCH /settings/slack`, `POST /settings/slack/test-message` | `settings.slack.write` | Admin |
| `POST /slack/interactive`, `POST /slack/commands/*` | none — HMAC-signature verified | Slack workspace |
| `GET /notifications*`, `POST /:id/read`, `/read-all`, `DELETE /:id` | authenticated (service narrows to caller) | Everyone |
| `POST /push/subscribe`, `POST /push/unsubscribe` | authenticated | Everyone |

Notifications and push subscriptions are **inherently owner-scoped** at the service layer — the route gate is just `authenticate`.

---

## `system_settings` collection ([`system-settings.model.ts`](../../src/models/system-settings.model.ts))

Singleton via unique `singleton_key: 'system'` index. Concurrent first-boot inserts collide on E11000 → service catches + retries read.

### Sections

| Section | Purpose | Admin-only on read? |
|---|---|---|
| `work_schedule` | start_time, end_time, working_days, daily_expected_hours | No |
| `leave_policy` | cl_carry_forward_cap, comp_off_hours_per_day, cl_advance_notice_days, pro_rata_for_joiners | No |
| `timesheet` | self_edit_window_days (default 7), daily_warn_threshold_hours (default 8) | No |
| `attendance` | geofence {enabled, center_lat, center_lon, radius_meters}, wifi_restriction {enabled, allowed_ssids, allowed_ip_ranges}, forgot_checkout_flag_time | No |
| `security` | password policy fields (min/max length, require_upper/lower/number/special), failed_login_threshold, lockout_duration_minutes, access_token_ttl_minutes (480 = 8h default), refresh_token_ttl_days (5), password_reset_ttl_minutes (60), `require_mfa_for_admins` (Step 28, default false) | **YES** — `ADMIN_ONLY_SECTIONS` |
| `uploads` | max_file_size_mb, allowed_mime_types, sas_token_ttl_minutes (15) | No |
| `slack` | enabled, channels {leaves, attendance, projects, timesheet, general}, bot_token (J1 AES-encrypted at rest) | **YES** |
| `email` | from_address, reply_to_address | **YES** |
| `reminders` | timesheet_reminder_time, task_due_reminder_run_interval_hours | No |
| `company` | name, logo_blob_key, primary_color, login_page_tagline | No |
| `default_timezone` | "Asia/Kolkata" — top-level scalar | No |

**`ADMIN_ONLY_SECTIONS = {security, email, slack}`** — non-admin reads strip these three sections entirely from the GET response. Admins see `security` + `email` raw; `slack` is redacted to `has_bot_token: bool` even for admins.

### Step-33 resolvers (hot-wire settings → runtime)

`security.*` policy fields are **stored** but not yet wired to all runtime sites (compile-time constants in `constants/auth.ts` are the active source for several). The migration is phased — Step 33 introduced per-resolver narrow shapes:

```ts
resolveLoginLockoutPolicy() → {failed_login_threshold, lockout_duration_minutes}
resolvePasswordPolicy() → {min_length, max_length, require_upper/lower/number/special}
resolvePasswordResetTtlMinutes() → number | null
```

Each returns `null` for any field when settings haven't been seeded (fresh-install bootstrap) so the caller can fall back to compile-time defaults without crashing. Failure mode: settings read throws → resolver re-raises → auth flow returns 500 (intentional — silently reverting to defaults during partial outage would hide config drift).

### Public branding endpoint (`GET /settings/public`)

Anonymous endpoint exposing **only** `PUBLIC_COMPANY_FIELDS = ['name', 'logo_blob_key', 'primary_color', 'login_page_tagline']` for the login page. Mounted **before** the authenticate middleware in `settings.routes.ts:18` so Express matches it first.

### PATCH semantics

- **Deep-merge per section** — arrays REPLACE (setting `working_days: [1,2,3]` removes 4 and 5).
- **Mongoose subdoc normalization** — current section is converted to POJO via `.toObject()` before merging so `deepMerge` doesn't treat the subdoc as a class instance and wipe nested `_id: false` fields.
- **`markModified(section)`** is mandatory for nested-path mutations to persist when the path holds a subdoc with `_id: false`.
- **Focused audit snapshots** — before/after captures only the sections in `Object.keys(patch)`, NOT the whole settings doc. Avoids blowing past the 16 KiB snapshot cap.
- **`slack.bot_token` redacted in audit snapshots** via `redactSlackBotTokenInPlace` — same redaction the dedicated `/settings/slack` PATCH applies. A Step-31 audit reader can never extract a historical secret through either entry point.

---

## Slack settings ([`slack-settings.service.ts`](../../src/services/slack-settings.service.ts))

Dedicated admin surface that bypasses the generic `/settings` PATCH for the Slack section specifically. Accepts a flat payload (no `{slack: {...}}` wrapper); `test-message` is the only endpoint that surfaces synchronous delivery success/failure.

### J1 — bot token encryption at rest

```ts
patchSlackSettings({bot_token: 'xoxb-...'}, caller):
  if patch.bot_token.length > 0:
    settings.slack.bot_token = encryptSecret(plaintext)        ← AES-GCM via crypto-aes.ts (reuses MFA_ENCRYPTION_KEY)
  else:
    settings.slack.bot_token = null
```

`encryptSecret` produces a `<b64url>.<b64url>.<b64url>` envelope (or `kid:<kid>:<3-parts>` for rotation). `decryptSecret` (in `utils/slack.ts:slackContextFrom` → `resolveBotTokenPlaintext`) reads either form.

**Legacy plaintext compatibility** — `looksEncrypted(stored)` detects the envelope shape. Pre-J1 plaintext tokens (still starting with `xoxb-/xoxa-/xapp-`) decrypt-bypass through `resolveBotTokenPlaintext` so the bot keeps working until the next PATCH migrates them in-place.

**Boot migration `migratePlaintextSlackBotToken()`** — fired during BE startup. Predicate-guarded `findOneAndUpdate({_id, 'slack.bot_token': stored})` so two boot replicas racing on the same legacy token only succeed once. Never throws (failures log warn + boot continues — the plaintext fallback keeps the bot working).

### Read redaction (`toPublicSlackSettings` / `toAuditSnapshot`)

Both projections strip `bot_token` and emit `has_bot_token: Boolean(s.bot_token)`. Admin reads of `/settings/slack` and audit `before/after` blocks BOTH go through these — no path exposes the live or historical token. Even the admin who just PATCHed the token doesn't get it echoed back on the response.

### Test message (`POST /settings/slack/test-message`)

```ts
sendTestMessage({channel, text?}, caller):
  if !isSlackConfigured(settings.slack):        ← 503 SLACK_NOT_CONFIGURED
    throw
  result = postSlackMessage(slackCtx, {channel, text, context: 'admin-test-message'})
  audit SLACK_TEST_MESSAGE {channel, delivered: result.success}
  if !result.success: throw 502 SLACK_DISPATCH_FAILED       ← synchronous failure surface
  return {delivered: true, channel}
```

**Synchronous-failure trade-off** — the test endpoint surfaces failure (502) so an admin sees "did this work" without log diving. The dispatcher's regular sends still swallow failures (best-effort).

---

## Slack webhooks ([`routes/slack.routes.ts`](../../src/routes/slack.routes.ts))

Inbound HMAC-signed webhooks mounted at `/api/v1/slack/*`. **Mounted BEFORE global body parsers** in `src/index.ts` — Slack signs the EXACT raw body bytes before parsing.

### Stack order (matters)

```
1. slackWebhookRateLimiter     — 30 req/min/IP (cheap reject before crypto)
2. slackWebhookMiddleware      — capture raw body buffer → verify HMAC → re-parse JSON/urlencoded
3. routes:
   POST /interactive           — Block Kit button clicks (Approve/Reject leave)
   POST /commands/:command     — /checkin, /checkout, /status
```

### Signature verification ([`utils/slack-signature.ts`](../../src/utils/slack-signature.ts))

```
v0:<timestamp>:<body>           ← signing base
HMAC-SHA256(SLACK_SIGNING_SECRET, base)    → hex
expected = `v0=<hex>`
crypto.timingSafeEqual(expected, X-Slack-Signature)
```

- **Replay window: 5 minutes** (`REPLAY_WINDOW_SECONDS = 300`). Older timestamps rejected.
- **`timingSafeEqual` wrapped in try/catch** — throws on different-length buffers; "no match" handled cleanly.
- **Never logs body or headers** — both contain Slack secrets when misconfigured.

### M6 — unified 401 response

Pre-M6 the middleware distinguished `401 bad_signature` from `503 no_secret` (signing secret env var unset). That let an unauthenticated probe distinguish "Slack not configured" from "I sent a bad signature." **Collapsed to identical 401 + generic body** — operators still see `code=SLACK_INTERACTIVE_REJECTED, reason=no_secret` in the warn log but the wire response carries no config disclosure.

### Body re-parsing after verification

After signature OK, the middleware re-parses `req.body`:
- `application/json` → `JSON.parse(bodyStr)`
- `application/x-www-form-urlencoded` (slash commands + interactive payloads) → `URLSearchParams` → flat object
- Other → pass raw string through

`req.rawBody` retained as Buffer for any downstream re-hashing need.

### Interactive controller ([`slack-interactive.controller.ts`](../../src/controllers/slack-interactive.controller.ts))

#### Approve/Reject buttons

```
payload = JSON.parse(req.body.payload)
if action_id starts with 'approve_leave_' or 'reject_leave_':
  user = resolveCaller(slack_user_id)              ← Slack→Viljetech mapping
  if !user: ephemeral "Couldn't identify…"
  if !isReviewer(user.role): ephemeral "no permission"

  audit = buildAuditContext(req, {overrideActor: {actor_id: user._id, actor_role: user.role}})
  caller = {id: user._id, role, audit}

  try:
    if approve: approveLeave(leaveId, {}, caller)
    if reject:  rejectLeave(leaveId, {approver_remarks: 'Rejected via Slack'}, caller)
    return 200 {}                              ← channel chat.update is the visible confirmation
  except:
    CORRECTION_REQUEST_NOT_PENDING → ephemeral "Already decided" (idempotent double-click)
    ADDITIONAL_APPROVAL_REASON_REQUIRED → ephemeral "approve via web app"
    other → ephemeral "Sorry, something went wrong."
```

**Response contract: ALWAYS 200 within Slack's 3-second window.** Errors and permission denials use `response_type: 'ephemeral'` (visible to the clicker only). The channel `chat.update` happens asynchronously via `notifyLeaveDecided` → same message in place, no new post.

#### Slash commands `/checkin`, `/checkout`, `/status`

Slack carries no client IP, no geolocation, no WiFi info. If org has geofence/wifi enforcement enabled, `checkIn`/`checkOut` throw `LOCATION_NOT_ALLOWED` → ephemeral "Slack check-in isn't available from your location — please use the web app or the office QR code."

`/status` reads `getMyToday(user._id)` → renders each segment as `• HH:MM → HH:MM` (or "now" if open) + total worked.

### Slack-user mapping ([`slack-user-mapping.service.ts`](../../src/services/slack-user-mapping.service.ts))

```
resolveSlackUser(slackUserId, ctx):
  1. User.findOne({slack_user_id: slackUserId})    ← O(1) once populated
  2. ctx.fetchUserInfo(slackUserId, botToken)       ← Slack users.info email lookup
     User.findOne({email: info.email.toLowerCase()})
     User.findByIdAndUpdate(byEmail._id, {slack_user_id: slackUserId})  ← cache for next call
  3. null → caller responds ephemeral
```

`fetchSlackUserInfo` wraps `users.info` with `SLACK_REQUEST_TIMEOUT_MS = 5000ms` (Slack's interactive 3s window + buffer) via AbortController. Returns null on any failure — caller's resolveSlackUser falls through to step 3.

---

## Outbound Slack ([`utils/slack.ts`](../../src/utils/slack.ts))

Thin `fetch`-based wrapper. Two helpers:

### `postSlackMessage(ctx, {channel, text, context})`

`POST chat.postMessage`. Never throws. Returns `SlackPostResult = {success: boolean, ts?, channel?}`. Failure modes:
- HTTP non-2xx → log + return `{success: false}`
- `{ok: false, error: 'channel_not_found' | ...}` body → log + return `{success: false}`
- Network error / timeout (AbortController, `SLACK_REQUEST_TIMEOUT_MS = 5000`) → log + return `{success: false}`

`SLACK_TEXT_MAX = 3000` chars (Slack truncates display at ~3000 even though API accepts 40 KiB).

### `postOrUpdateSlackMessage(ctx, {channel, blocks, text?, existing, context})`

Phase 1 lifecycle messages. When `existing: null` → `chat.postMessage`. When `existing: {channel, ts}` → `chat.update` keyed by `ts` (mutates the original Block Kit message in place rather than spamming a new post per state change).

Used by `notifyLeaveSubmitted` (initial post — persists `ts + channel` to `LeaveRequest.slack_message`) and `notifyLeaveDecided` (update against stored coords). On legacy leaves without `slack_message`, falls back to a fresh post and persists the new coords for future updates.

`chat.update` failure mode `message_not_found` (bot kicked, message deleted, ts mismatch) → log + `{success: false}`. BE state change still succeeds; channel just shows the stale message.

### `isSlackConfigured` + `slackContextFrom`

Caller-side gates: `enabled === true && Boolean(bot_token)`. `slackContextFrom` returns `{enabled, botToken}` resolved via `resolveBotTokenPlaintext` (J1 envelope-aware), or `null` when unconfigured.

---

## Notification dispatcher ([`notification-dispatcher.service.ts`](../../src/services/notification-dispatcher.service.ts), 984 lines)

The **single fan-out point** every business event calls. One `notifyXxx(...)` helper per event type. Each:

1. Resolves recipients (single user or fan-out pool).
2. Loads Slack dispatch context once per event (NOT per recipient).
3. Calls `dispatchToRecipient(recipient, payload, email, context, slack)` per recipient.
4. **NEVER throws** — top-level try/catch with `logger.warn({code: NOTIFICATION_DISPATCH_FAILED, dispatch_event})`.

### `dispatchToRecipient` — 4 channels per recipient

```
1. In-app row     — Notification.create(...)
                    Failure logged as channel: 'in_app'; still try email + Slack + push
2. Email          — sendEmail({to, subject, html, text, context})
                    Best-effort; mailer is pluggable (stub/acs/mailjet)
3. Slack DM       — if recipient.slack_user_id && slack_notifications_enabled !== false
                    AND slack context loaded
                    → postSlackMessage(ctx, {channel: slack_user_id, text: buildSlackText(payload), context: `${context}.dm`})
4. Web Push       — if isPushConfigured() && push_notifications_enabled !== false
                    → listSubscriptionsForUser(recipient._id)
                    → for each subscription: sendPushNotification(...)
```

Each channel failure is **independent** — channel 1 failure doesn't skip 2-4.

### Slack broadcast vs DM

`loadSlackDispatch()` returns `{ctx, channels}` once per event. Broadcasts (`dispatchSlackBroadcast`) post to the type-mapped channel via `NOTIFICATION_TYPE_TO_SLACK_CATEGORY`:

| NotificationType | Slack category |
|---|---|
| LEAVE_* | `leaves` |
| ATTENDANCE_CORRECTION_* | `attendance` |
| TASK_* | `projects` |
| TIMESHEET_REMINDER | `timesheet` |
| SYSTEM | `general` |

Per-recipient DMs are fired inside `dispatchToRecipient` (channel = recipient's `slack_user_id`).

**Mentions are DM-only** (no channel broadcast for `notifyTaskCommentMention`) — a channel post would surface private team chatter into a noisy `#projects` feed.

### R11 — bounded fan-out (`runWithConcurrency`)

```ts
const NOTIFICATION_FAN_OUT_CONCURRENCY = 5;
await runWithConcurrency(reviewers, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
  dispatchToRecipient(...)
);
```

Pre-R11 a 50-member project blasted 50 parallel `sendEmail` calls past ACS/Mailjet burst caps. 5 concurrent dispatches is enough for typical fan-out to finish within a normal request timeout; downstream services see at most 5 sustained requests/instance.

### Recipient resolution

| Helper | Returns |
|---|---|
| `findReviewerPool(excludeUserId)` | Active admins + managers, excluding the actor |
| `findUserById(id)` | Single recipient (used for requester) |
| `resolveActorName(actor, fallback?)` | Display name for the email/Slack body |

Recipient resolution **always excludes the actor** — "you submitted a leave" notifications about your own action are noise.

### Notify helpers (Phase-1 surface)

| Helper | Event | Recipients |
|---|---|---|
| `notifyLeaveSubmitted` | New leave applied | Reviewer pool (admin + manager) — broadcast + DM. Posts Block Kit message with Approve/Reject buttons, persists `slack_message: {channel, ts}` to `LeaveRequest` |
| `notifyLeaveDecided` | Approve/reject/cancel | Requester (approve/reject); Requester + reviewer pool ex-actor (cancel). Updates the original Block Kit message in-place via `chat.update` against `LeaveRequest.slack_message` |
| `notifyAttendanceCorrectionSubmitted` | New correction request | Reviewer pool — broadcast + DM |
| `notifyAttendanceCorrectionDecided` | Approve/reject | Requester only (skips actor=requester) — DM (no broadcast) |
| `notifyUserInvited` | Admin creates user | The invited user — **email only** (no session yet, in-app bell irrelevant) |
| `notifyTaskCommentMention` | Comment with @mentions | Mentioned users (excluding author) — in-app + email + DM only (no broadcast — mentions are private) |
| `notifyTaskCommentWatchers` (BUG-068) | Comment without @mention | Task assignee/collaborators/creator/prior commenters — **in-app only**, no email/slack (quieter than mention path) |
| `notifyTimesheetReminder` | Daily 20:00 cron | Individual user — DM only, no broadcast (a "these N forgot to log time" feed would be embarrassing) |

---

## Notifications collection ([`notification.model.ts`](../../src/models/notification.model.ts))

```ts
{
  _id, user_id,
  type: 'leave_requested'|'leave_approved'|'leave_rejected'|'leave_cancelled'
       |'task_assigned'|'task_due_soon'|'task_overdue'|'task_comment'
       |'attendance_correction_requested'|'attendance_correction_decided'
       |'timesheet_reminder'|'system',
  title: string,                        // ≤ 200
  body: string,                          // ≤ 2000
  link_url: string,                      // ≤ 1000
  related_entity: {kind, id} | null,
  is_read: boolean,
  read_at: Date | null,
  created_at, updated_at,
}
```

**Indexes** (Data_Model §7.1):
- `{user_id: 1, created_at: -1}` — bell list (default sort)
- `{user_id: 1, is_read: 1}` — unread-count badge

### Endpoints ([`notification.service.ts`](../../src/services/notification.service.ts))

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/notifications` | Paginated `?is_read&type&page&limit` — owner-scoped at service |
| `GET` | `/notifications/unread-count` | `Notification.countDocuments({user_id, is_read: false})` |
| `POST` | `/notifications/:id/read` | **Atomic conditional** `findOneAndUpdate({_id, user_id, is_read: false}, {is_read: true, read_at: now})`. Idempotent: already-read row → returns existing without re-stamping `read_at`. Cross-user/missing → 404 `RESOURCE_NOT_FOUND` |
| `POST` | `/notifications/read-all` | `updateMany({user_id, is_read: false}, {is_read: true, read_at: now})` |
| `DELETE` | `/notifications/:id` | Hard delete; owner-scoped; cross-user/missing → 404 |

**Anti-enumeration**: "not yours" and "doesn't exist" both return `RESOURCE_NOT_FOUND` so the bell can't be used as an existence probe.

**No TTL** — rows live forever; dismiss is a hard delete on user's request. Phase 3 may add "delete read older than N days" cleanup cron.

---

## Push subscriptions ([`push-subscription.service.ts`](../../src/services/push-subscription.service.ts) + [`utils/push.ts`](../../src/utils/push.ts))

### Subscribe (`POST /push/subscribe`)

Idempotent via `findOneAndUpdate({user_id, endpoint}, {...}, {upsert: true})`. The unique compound index `(user_id, endpoint)` guarantees no duplicate rows even under concurrent re-subscribes from multiple tabs.

**H6 — audit only the actual subscribe (insert), NOT idempotent re-subscribe upsert.** Predicate-guarded by `existing = findOne(...)` before the upsert.

**Audit metadata**:
- `endpoint_host` (hostname-only via `safeEndpointHost`) — the full URL contains a subscription-ID path component that's effectively a secret; only the push-service hostname is in the audit.

### Unsubscribe (`POST /push/unsubscribe` + `DELETE /push/subscribe` alias)

**M21** — `POST /push/unsubscribe` is canonical. `DELETE /push/subscribe` kept as alias for in-flight clients still on the old shape. The DELETE-with-body pattern is fragile across fetch implementations (Service Worker `fetch`, some CDN edges silently strip DELETE bodies), which motivated the swap.

`deleteSubscriptionByEndpoint(user_id, endpoint, audit?)`:
- Capture row's `_id` BEFORE deletion so the audit row points at a known target.
- `deleteOne({user_id, endpoint})` → `{deleted: number}`.
- Audit only when `deleted > 0` (idempotent miss → no event happened, no audit row).

### Dispatch (`sendPushNotification` in [`utils/push.ts`](../../src/utils/push.ts))

**Smart-prune semantics**:
- **410 Gone / 404 Not Found** → endpoint permanently dead (user revoked permission, browser re-installed). Hard-delete the subscription row + log INFO with `pruned: true`.
- **Any other failure** (rate limit, network blip, transient 5xx) → stamp `last_error_at`; leave row alone.
- **Success** → stamp `last_used_at`.

**H18 — 10s timeout via `web-push` library**: `web-push` uses Node's default agent with no socket timeout; a misbehaving Mozilla/FCM endpoint can stall the dispatcher's per-fanout worker (concurrency = 5) indefinitely. 10s is standard + well past the p99 send latency of every legit provider.

**C8 endpoint allowlist re-check** at dispatch time:
- Pre-C8 the validator was `z.string().url()` — any logged-in user could submit `http://169.254.169.254/...` (AWS IMDS), `http://localhost:6379/`, etc. The dispatcher would `webPush.sendNotification` POST to internal targets — usable SSRF / port-scan / OAST primitive.
- C8 closed the front door (subscribe validator). The dispatcher **re-validates** before sending — pre-C8 rows still pointing at unsafe targets are hard-deleted on first dispatch attempt + logged.

`isAllowedPushEndpoint(url)` allowlist:
- HTTPS only (push providers never use HTTP).
- Host `===` or `endsWith('.${host}')` one of `googleapis.com, push.services.mozilla.com, push.apple.com, notify.windows.com` — subdomain match passes (`fcm.googleapis.com`); suffix-bypass fails (`attackergoogleapis.com`).

### VAPID configuration

Three env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Configured lazily on first `sendPushNotification` call (so unit tests can mock `web-push` without env reads). `isPushConfigured()` is a pure sync env check used by the dispatcher to skip push entirely when unconfigured.

**Public key NOT exposed via API** — baked into the FE bundle at build time via `VITE_VAPID_PUBLIC_KEY`. Saves one round-trip on first subscribe.

### Boot migration `migrateDisallowedPushEndpoints()`

One-shot prune at startup: cursor-stream every `PushSubscription` row, `deleteOne` any whose endpoint fails `isAllowedPushEndpoint`. Idempotent (post-deploy rows always pass since the subscribe validator gates them). Never throws — failures log `PUSH_ENDPOINT_MIGRATION_FAILED` + boot continues.

---

## Audit actions

| Action | When |
|---|---|
| `settings.update` | Generic `PATCH /settings` (sections_touched in metadata) |
| `settings.slack_update` | `PATCH /settings/slack` (bot_token redacted in snapshots) |
| `slack.test_message` | `POST /settings/slack/test-message` (`channel, delivered` in metadata) |
| `push_subscription.create` (H6) | First-time `POST /push/subscribe` (not re-upsert) — `endpoint_host` only |
| `push_subscription.delete` (H6) | `POST /push/unsubscribe` when `deleted > 0` |

Notifications themselves are NOT audited — high-volume routine events with no forensic value (the audit row's `target.kind` would be `notification` and the row data is already in `notifications` collection).

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `SLACK_NOT_CONFIGURED` | 503 | Test message when Slack is disabled or no bot_token |
| `SLACK_DISPATCH_FAILED` | 502 (test only) / log-warn (dispatcher) | Slack API rejected the send |
| `SLACK_INTERACTIVE_REJECTED` | 401 (M6 — unified with bad-signature) | Webhook signature failed OR signing secret unset |
| `NOTIFICATION_DISPATCH_FAILED` | log-warn only | One channel of the fan-out failed; primary write still 2xx |
| `PUSH_DISPATCH_FAILED` | log-warn only | Push send failed (transient or pruned) |
| `RESOURCE_NOT_FOUND` | 404 | Cross-user notification id OR truly missing |
| `MFA_REQUIRED` | 403 | Step 28 — `require_mfa_for_admins=true` and admin without MFA tries a mutation |

---

## End-to-end flows

### Admin enables Slack

1. `PATCH /settings/slack {enabled: true, bot_token: 'xoxb-...', channels: {leaves: '#hr-leaves'}}`.
2. Service: `encryptSecret('xoxb-...')` via AES-GCM → store envelope. Audit `settings.slack_update {bot_token_changed: true, enabled_changed: true}` with redacted snapshots.
3. Response: `{enabled: true, has_bot_token: true, channels: {...}}`. Raw token NEVER echoed.
4. Admin calls `POST /settings/slack/test-message {channel: '#hr-leaves'}`.
5. Service: `isSlackConfigured` ✓ → `slackContextFrom(settings.slack)` → `resolveBotTokenPlaintext` decrypts → `postSlackMessage(...)`.
6. Slack `ok: true` → audit `slack.test_message {channel: '#hr-leaves', delivered: true}` → response `{delivered: true, channel: '#hr-leaves'}`.

### Employee applies leave → dispatcher fans out

1. `POST /leaves {...}`. Service writes the leave row.
2. `notifyLeaveSubmitted({request_id, requester_id, ...})` fires.
3. Dispatcher: `findUserById(requester)` + `findReviewerPool(excludeUserId: requester)` in parallel.
4. `loadSlackDispatch()` → `{ctx, channels}` (loaded once).
5. **Slack broadcast** → `postOrUpdateSlackMessage(ctx, {channel: '#hr-leaves', blocks: buildLeaveMessageBlocks(...), text: 'Leave request from ...', existing: null})`. Slack returns `{ok: true, ts: '1718...', channel: 'C012ABC'}` → `LeaveRequest.findByIdAndUpdate({slack_message: {channel: 'C012ABC', ts: '1718...'}})`.
6. **Per-recipient fan-out** via `runWithConcurrency(reviewers, 5, dispatchToRecipient(...))`:
   - In-app row.
   - Email render + `sendEmail(...)`.
   - Slack DM to each reviewer's `slack_user_id` (if mapped + opted-in).
   - Push to each reviewer's stored subscriptions.

### Manager clicks Approve in Slack

1. Slack POSTs `/api/v1/slack/interactive {payload: '{"type":"block_actions","user":{"id":"U123"},"actions":[{"action_id":"approve_leave_<id>"}]}'}`.
2. Middleware: rate-limit → raw-body capture → HMAC verify against `SLACK_SIGNING_SECRET` (5-min window) → re-parse body.
3. Controller: `resolveCaller('U123')` → mapped Viljetech user. `isReviewer(role) === true`.
4. `buildAuditContext(req, {overrideActor: {actor_id: user._id, actor_role: user.role}})` — audit ties to the Slack actor.
5. `approveLeave(leaveId, {}, caller)` — same service path as the HTTP route. Writes `audit.leave.approve`.
6. Service triggers `notifyLeaveDecided({decision: 'approved', actor: {id: user._id}})`.
7. Dispatcher `chat.update`s the original Block Kit message in place via `LeaveRequest.slack_message`. Channel sees ONE message with the lifecycle (pending → approved).
8. Controller returns `200 {}` within Slack's 3s window. Channel update is async.

### Concurrent Slack double-click

1. Manager double-clicks Approve. Both clicks reach the controller within 1s.
2. First call: atomic CAS pending→approved succeeds → 200.
3. Second call: CAS finds non-pending → `CORRECTION_REQUEST_NOT_PENDING` thrown.
4. Controller catches → `ephemeral('This leave was already decided.')`.

### Employee unsubscribes push from device A

1. FE in device A: service-worker unsubscribe → `POST /push/unsubscribe {endpoint: 'https://fcm.googleapis.com/...'}`.
2. Service: capture `_id` + `user_agent` BEFORE delete. `deleteOne({user_id, endpoint})` → `{deleted: 1}`.
3. Audit `push_subscription.delete` with `endpoint_host: 'fcm.googleapis.com'` (NOT the full URL).
4. Device B's subscription still alive — independent row.

### Push provider returns 410 on dispatch

1. Dispatcher fan-out includes user U with 2 push subscriptions.
2. Subscription A: `webPush.sendNotification(...)` succeeds → `last_used_at: now`.
3. Subscription B: `webPush.sendNotification(...)` throws `WebPushError{statusCode: 410}`.
4. `isPermanentlyDead(410) === true` → `PushSubscription.deleteOne({_id: subB._id})`. Log INFO `pruned: true`.
5. Next dispatch only fan-outs to A.

### Pre-C8 stranded subscription auto-pruned on dispatch

1. Legacy row from before C8: endpoint = `http://169.254.169.254/latest/meta-data/`.
2. Dispatcher fan-out reaches this row. `isAllowedPushEndpoint(endpoint) === false` (HTTP not HTTPS; internal IP).
3. Hard-delete + log warn `code: PUSH_DISPATCH_FAILED, reason: endpoint_not_allowlisted`.
4. Future dispatches don't include this row.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | `settings` is a singleton via unique `singleton_key: 'system'` index | Concurrent first-boot inserts collide on E11000; service catches + reads winner |
| 2 | `ADMIN_ONLY_SECTIONS = {security, email, slack}` stripped from non-admin GET | API contract — security policy + comms config aren't read-visible to ICs |
| 3 | Even admin GET redacts `slack.bot_token` to `has_bot_token: bool` | No path echoes the token back |
| 4 | PATCH deep-merge: arrays REPLACE | Setting `working_days: [1,2,3]` removes 4+5 |
| 5 | PATCH normalizes Mongoose subdocs to POJO before merge | Otherwise `deepMerge` treats them as opaque and wipes nested fields |
| 6 | `markModified(section)` required after nested-path mutation on `_id: false` subdocs | Mongoose change-tracking misses otherwise |
| 7 | PATCH audit captures only affected sections (NOT full settings) | Avoids 16 KiB snapshot cap |
| 8 | PATCH audit redacts `slack.bot_token` in before+after | Same redaction as the read path; audit can't be used as token-recovery |
| 9 | J1 — Slack bot_token encrypted at rest via AES-GCM | Reuses `MFA_ENCRYPTION_KEY` |
| 10 | `looksEncrypted` detects envelope shape (`<b64>.<b64>.<b64>` or `kid:...`) | Distinguishes from `xoxb-` prefix legacy plaintext |
| 11 | `resolveBotTokenPlaintext` decrypts envelopes; falls back to legacy plaintext | Pre-J1 deployments keep working until next PATCH migrates |
| 12 | `migratePlaintextSlackBotToken()` runs once at boot — predicate-guarded `findOneAndUpdate` | Race-safe across boot replicas |
| 13 | `/settings/public` is anonymous — branding only | Mounted BEFORE `authenticate` middleware in `settings.routes.ts` |
| 14 | Step-33 resolvers return `null` per field when settings unseeded | Fresh-install bootstrap falls back to compile-time defaults |
| 15 | Slack webhook routes MOUNTED BEFORE body parsers in `src/index.ts` | Slack signs raw bytes; parsing destroys them |
| 16 | `slackWebhookMiddleware` uses `express.raw({type: '*/*'})` then re-parses | Capture buffer → verify HMAC → parse JSON or urlencoded |
| 17 | HMAC base = `v0:<ts>:<body>`; replay window 5 min | Per Slack docs |
| 18 | `timingSafeEqual` wrapped in try/catch | Throws on different-length buffers; "no match" handled |
| 19 | M6 — `no_secret` env unset returns 401 (same as bad signature) | No config disclosure over the wire; operator sees the warn log |
| 20 | Slack interactive responds 200 ALWAYS within 3s; errors are ephemeral text | Slack retries on >3s timeout — risks double-action |
| 21 | Slack approve/reject uses `buildAuditContext(req, {overrideActor})` | Audit attributes to the Slack actor, not anonymous |
| 22 | Slack reject defaults `approver_remarks: 'Rejected via Slack'` | HTTP route validator requires ≥ 1 char; Slack has no text input |
| 23 | Slack approve refuses `ADDITIONAL_APPROVAL_REASON_REQUIRED` → "approve via web app" | Block Kit has no text input for the override reason |
| 24 | Slash commands `/checkin /checkout /status` use `method: 'manual'` | No QR/geolocation/wifi info in Slack payloads |
| 25 | `LOCATION_NOT_ALLOWED` on Slack check-in → "use web app or office QR" | When geofence/wifi enabled, Slack can't satisfy |
| 26 | `resolveSlackUser` caches `slack_user_id` back on Viljetech User after first `users.info` match | O(1) on subsequent calls |
| 27 | `postSlackMessage` returns `SlackPostResult` envelope (NOT boolean) | Phase-1 needed `ts + channel` for `chat.update` |
| 28 | `postOrUpdateSlackMessage` chooses `chat.postMessage` vs `chat.update` based on `existing` | Lifecycle messages mutate in-place; one message per leave |
| 29 | Legacy leaves without `slack_message` fall back to fresh post + persist new coords | Next state change can update |
| 30 | `chat.update` failure (`message_not_found`) is logged + soft — BE state still succeeds | Channel shows stale message |
| 31 | `SLACK_TEXT_MAX = 3000`; truncated with ellipsis | Slack display cap |
| 32 | `SLACK_REQUEST_TIMEOUT_MS = 5000` via AbortController | Cron tick fanning out to 100 users can't stall on one Slack call |
| 33 | Dispatcher fan-out cap `NOTIFICATION_FAN_OUT_CONCURRENCY = 5` (R11) | ACS/Mailjet burst caps; 50-member project doesn't blast |
| 34 | All 4 channels fail INDEPENDENTLY — channel 1 failure doesn't skip 2-4 | Each wrapped in try/catch with channel tag |
| 35 | Dispatcher excludes the actor from recipients | "You submitted a leave" notifications are noise |
| 36 | Mentions are DM-only (no `dispatchSlackBroadcast`) | Channel post surfaces private team chatter |
| 37 | `notifyTaskCommentWatchers` is in-app-only (no email, no Slack) | Quieter than mention path |
| 38 | `notifyUserInvited` is email-only | Invitee has no session yet, in-app bell irrelevant |
| 39 | Notifications: mark-as-read is atomic `findOneAndUpdate({is_read: false}, ...)` | Idempotent: already-read row returned without re-stamping `read_at` |
| 40 | Cross-user notification action → 404 `RESOURCE_NOT_FOUND` (NOT 403) | Anti-enumeration |
| 41 | No TTL on notifications | Phase-3 cleanup cron is a future concern |
| 42 | M21 — `POST /push/unsubscribe` is canonical; `DELETE /push/subscribe` is alias | DELETE-with-body is fragile across SW fetch, CDN edges |
| 43 | Push subscribe is idempotent via `findOneAndUpdate({upsert: true})` + unique compound `(user_id, endpoint)` | Re-mount doesn't duplicate rows |
| 44 | H6 — audit only first-time subscribe (insert), not re-upsert | Pre-emption via `existing = findOne(...)` before upsert |
| 45 | Push audit metadata uses `endpoint_host` (NOT full URL) | Path component is effectively secret |
| 46 | C8 endpoint allowlist re-checked at dispatch time | Pre-C8 stranded rows auto-pruned on next send |
| 47 | `isAllowedPushEndpoint` allowlist: HTTPS + hostname `===` or `endsWith('.${host}')` | SSRF defense; subdomain match passes, suffix-bypass fails |
| 48 | Boot migration `migrateDisallowedPushEndpoints` cursor-streams + prunes | Idempotent; cleans pre-C8 rows |
| 49 | H18 — `webPush.sendNotification({timeout: 10_000})` | Library default is no socket timeout; misbehaving endpoint stalls forever |
| 50 | Push 410/404 → hard-delete subscription; transient error → stamp `last_error_at` | Smart-prune semantics |
| 51 | VAPID public key NOT exposed via API — baked into FE bundle | Saves one round-trip on first subscribe |
| 52 | Notification metadata target.kind is one of `leave_request, attendance_correction_request, user, task` | Free-form string accepted; this list documents emitted kinds |
