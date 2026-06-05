import { Types } from 'mongoose';

import { SystemSettings, type SlackSettings } from '../models/system-settings.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { encryptSecret } from '../utils/crypto-aes.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { getOrInitSettings } from './settings.service.js';
import { isSlackConfigured, looksEncrypted, postSlackMessage, slackContextFrom } from '../utils/slack.js';
import logger from '../utils/logger.js';
import type { PatchSlackSettingsBody, TestMessageBody } from '../validators/slack-settings.validator.js';

/**
 * Slack settings service (Step 25).
 *
 * Three operations land here, all admin-only at the route layer:
 *
 *   1. `getSlackSettings` — return the current Slack section with
 *      `bot_token` redacted to `{has_bot_token: bool}`. Even an admin
 *      doesn't get the raw secret echoed back on every read; the only
 *      way to retrieve it is to PATCH a known value.
 *
 *   2. `patchSlackSettings` — merge into the singleton settings doc.
 *      Partial updates per field; an empty string `bot_token` is the
 *      explicit "clear" signal (coerced to null on store). Audits the
 *      change with `before/after` snapshots that themselves redact
 *      the token (presence-only) so the audit row is safe to read in
 *      the Step-31 UI.
 *
 *   3. `sendTestMessage` — fires a plain `chat.postMessage` to the
 *      caller-supplied channel using the live bot token. Returns
 *      `{delivered: true}` on Slack's `ok=true`, throws 502 on any
 *      failure so the admin sees a synchronous "did this work" answer.
 *      (The dispatcher's never-throws contract is for the cron / event
 *      paths; the test endpoint is operator tooling and SHOULD surface
 *      failures.)
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface SlackSettingsCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Public projections (redact bot_token to a presence flag) ────────────

interface PublicSlackSettings {
    enabled: boolean;
    channels: SlackSettings['channels'];
    has_bot_token: boolean;
}

const toPublicSlackSettings = (s: SlackSettings): PublicSlackSettings => ({
    enabled: s.enabled,
    channels: { ...s.channels },
    has_bot_token: Boolean(s.bot_token),
});

/**
 * Audit-safe snapshot. Same shape as the public projection (presence
 * flag, never the raw token) so an audit log reader can't extract a
 * historical secret either.
 */
const toAuditSnapshot = (s: SlackSettings): Record<string, unknown> => ({
    enabled: s.enabled,
    channels: { ...s.channels },
    has_bot_token: Boolean(s.bot_token),
});

// ─── GET /settings/slack ─────────────────────────────────────────────────

export const getSlackSettings = async (): Promise<PublicSlackSettings> => {
    const settings = await getOrInitSettings();
    return toPublicSlackSettings(settings.slack);
};

// ─── PATCH /settings/slack ───────────────────────────────────────────────

export const patchSlackSettings = async (
    patch: PatchSlackSettingsBody,
    caller: SlackSettingsCaller
): Promise<PublicSlackSettings> => {
    const settings = await getOrInitSettings();
    const before = toAuditSnapshot(settings.slack);

    if (patch.enabled !== undefined) settings.slack.enabled = patch.enabled;

    if (patch.bot_token !== undefined) {
        // J1 — encrypt bot_token at rest. Pre-J1 it was stored as raw
        // plaintext, the inconsistent outlier alongside MFA secrets
        // (encrypted) and refresh tokens (hashed). The same AES-GCM
        // helper now serves both surfaces. Empty string + null both
        // clear; the cleared sentinel stays plaintext null because
        // there's nothing to protect.
        if (patch.bot_token && patch.bot_token.length > 0) {
            settings.slack.bot_token = encryptSecret(patch.bot_token);
        } else {
            settings.slack.bot_token = null;
        }
    }

    if (patch.channels) {
        if (patch.channels.leaves !== undefined) settings.slack.channels.leaves = patch.channels.leaves;
        if (patch.channels.attendance !== undefined) settings.slack.channels.attendance = patch.channels.attendance;
        if (patch.channels.projects !== undefined) settings.slack.channels.projects = patch.channels.projects;
        if (patch.channels.timesheet !== undefined) settings.slack.channels.timesheet = patch.channels.timesheet;
        if (patch.channels.general !== undefined) settings.slack.channels.general = patch.channels.general;
    }

    settings.updated_by = caller.id;
    await settings.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SETTINGS_SLACK_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: settings._id },
            before,
            after: toAuditSnapshot(settings.slack),
            metadata: {
                bot_token_changed: patch.bot_token !== undefined,
                enabled_changed: patch.enabled !== undefined,
            },
        });
    }

    return toPublicSlackSettings(settings.slack);
};

// ─── POST /settings/slack/test-message ───────────────────────────────────

export interface TestMessageResult {
    delivered: true;
    channel: string;
}

export const sendTestMessage = async (
    input: TestMessageBody,
    caller: SlackSettingsCaller
): Promise<TestMessageResult> => {
    const settings = await getOrInitSettings();
    if (!isSlackConfigured(settings.slack)) {
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.SLACK_NOT_CONFIGURED,
            message: 'Slack is not configured — set a bot token and toggle slack.enabled before testing.',
        });
    }

    const slackCtx = slackContextFrom(settings.slack);
    if (!slackCtx) {
        // Defence in depth — `isSlackConfigured` already gates this.
        throw new AppError({
            statusCode: 503,
            code: ERROR_CODES.SLACK_NOT_CONFIGURED,
            message: 'Slack context could not be resolved from current settings.',
        });
    }

    const text = input.text ?? 'Viljetech Slack integration test — if you see this, channel routing works.';

    const result = await postSlackMessage(slackCtx, {
        channel: input.channel,
        text,
        context: 'admin-test-message',
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SLACK_TEST_MESSAGE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: settings._id },
            metadata: { channel: input.channel, delivered: result.success },
        });
    }

    if (!result.success) {
        // The test endpoint surfaces the failure synchronously so the
        // admin can fix their token / channel without trawling logs.
        // The dispatcher's regular sends still swallow failures per
        // `SLACK_DISPATCH_FAILED` policy.
        throw new AppError({
            statusCode: 502,
            code: ERROR_CODES.SLACK_DISPATCH_FAILED,
            message: 'Slack rejected the test message — see server logs for the underlying reason.',
        });
    }

    return { delivered: true, channel: input.channel };
};

// ─── Boot-time migration (J1) ─────────────────────────────────────────────

/**
 * One-shot startup migration: if the singleton settings doc carries a
 * legacy plaintext `slack.bot_token`, encrypt it in place. Idempotent —
 * a value that already looks like an AES envelope is left alone.
 *
 * Safe under concurrent boot replicas because the `findOneAndUpdate`
 * predicate matches the legacy plaintext token; the loser of the race
 * has nothing to update on its second pass.
 *
 * Why a separate boot step rather than lazy migration on read:
 *   - Eager migration means the DB is consistent immediately after
 *     deploy; operators don't need to remember to "PATCH the slack
 *     settings to migrate".
 *   - Read-path code stays simple: `slackContextFrom` only needs the
 *     legacy plaintext fallback for the in-flight migration window.
 *   - Failures here log a warn and proceed — boot must not block on
 *     a legacy token that fails to encrypt for any reason.
 */
export const migratePlaintextSlackBotToken = async (): Promise<{ migrated: boolean }> => {
    try {
        const doc = await SystemSettings.findOne().select('slack.bot_token');
        if (!doc) return { migrated: false };
        const stored = doc.slack?.bot_token;
        if (!stored || stored.length === 0) return { migrated: false };
        if (looksEncrypted(stored)) return { migrated: false };

        const encrypted = encryptSecret(stored);
        // Predicate-guarded swap — if a concurrent boot replica already
        // encrypted the value, our update finds nothing and is a no-op.
        const result = await SystemSettings.updateOne(
            { _id: doc._id, 'slack.bot_token': stored },
            { $set: { 'slack.bot_token': encrypted } }
        );
        const migrated = (result.modifiedCount ?? 0) > 0;
        if (migrated) {
            logger.info('Migrated legacy plaintext Slack bot_token to encrypted-at-rest storage');
        }
        return { migrated };
    } catch (err) {
        // Never block boot on a migration step — log and continue. The
        // read path's plaintext fallback will keep the bot working.
        logger.warn({ err }, 'Slack bot_token plaintext migration failed; continuing boot');
        return { migrated: false };
    }
};
