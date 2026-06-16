import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `slack-settings.service` (Step 25).
 *
 * Coverage focus:
 *   1. `getSlackSettings` — `bot_token` redacted to `has_bot_token`.
 *   2. `patchSlackSettings` — partial updates merge cleanly; empty
 *      string `bot_token` clears; audit row uses redacted snapshots
 *      (no raw token leak); `bot_token_changed` flag mirrors the
 *      patch.
 *   3. `sendTestMessage` — 503 SLACK_NOT_CONFIGURED when disabled,
 *      503 when bot_token is missing, 502 SLACK_DISPATCH_FAILED when
 *      Slack rejects the message, 200 + audit row on success.
 */

// `vi.hoisted` runs before imports, so we cannot construct an
// ObjectId here — the settings doc's `_id` is filled in `beforeEach`.
// The mock's `slack` shape is widened with `as` so individual tests
// can flip `enabled` / `bot_token` between `string`/`null` without
// fighting the inferred-literal types.
interface MockSlack {
    enabled: boolean;
    bot_token: string | null;
    channels: {
        leaves: string;
        attendance: string;
        projects: string;
        timesheet: string;
        general: string;
    };
    attendance_nudges: {
        enabled: boolean;
        check_in_time: string;
        checkout_reminder_time: string;
    };
}
interface MockSettings {
    slack: MockSlack;
    _id: unknown;
    updated_by: unknown;
    save: ReturnType<typeof vi.fn>;
}

const { systemSettingsFindOneMock, systemSettingsUpdateOneMock } = vi.hoisted(() => ({
    systemSettingsFindOneMock: vi.fn(),
    systemSettingsUpdateOneMock: vi.fn(),
}));

vi.mock('../models/system-settings.model.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../models/system-settings.model.js')>();
    return {
        ...actual,
        SystemSettings: {
            findOne: systemSettingsFindOneMock,
            updateOne: systemSettingsUpdateOneMock,
        },
    };
});

const { settingsMock, recordAuditMock, postSlackMessageMock } = vi.hoisted(() => {
    const mock: {
        slack: {
            enabled: boolean;
            bot_token: string | null;
            channels: {
                leaves: string;
                attendance: string;
                projects: string;
                timesheet: string;
                general: string;
            };
            attendance_nudges: {
                enabled: boolean;
                check_in_time: string;
                checkout_reminder_time: string;
            };
        };
        _id: unknown;
        updated_by: unknown;
        save: ReturnType<typeof vi.fn>;
    } = {
        slack: {
            enabled: true,
            bot_token: 'xoxb-test',
            channels: {
                leaves: '#leaves',
                attendance: '#attendance',
                projects: '#projects',
                timesheet: '#timesheet',
                general: '#general',
            },
            attendance_nudges: {
                enabled: false,
                check_in_time: '11:00',
                checkout_reminder_time: '20:00',
            },
        },
        _id: null,
        updated_by: null,
        save: vi.fn(),
    };
    return {
        settingsMock: mock,
        recordAuditMock: vi.fn(),
        postSlackMessageMock: vi.fn(),
    };
});

// Re-typed alias so test bodies can assign null to `bot_token` etc.
const _typedSettings: MockSettings = settingsMock as unknown as MockSettings;
void _typedSettings;

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: vi.fn(async () => settingsMock),
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('../utils/slack.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/slack.js')>();
    return {
        ...actual,
        postSlackMessage: postSlackMessageMock,
    };
});

const svc = await import('./slack-settings.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { decryptSecret } from '../utils/crypto-aes.js';
import { looksEncrypted } from '../utils/slack.js';

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });

beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.slack = {
        enabled: true,
        bot_token: 'xoxb-test',
        channels: {
            leaves: '#leaves',
            attendance: '#attendance',
            projects: '#projects',
            timesheet: '#timesheet',
            general: '#general',
        },
        attendance_nudges: {
            enabled: false,
            check_in_time: '11:00',
            checkout_reminder_time: '20:00',
        },
    };
    settingsMock._id = new Types.ObjectId();
    settingsMock.save.mockImplementation(async () => settingsMock);
});

// ─── getSlackSettings ────────────────────────────────────────────────────

describe('getSlackSettings', () => {
    it('redacts the raw bot_token to a presence flag', async () => {
        const result = await svc.getSlackSettings();
        expect(result).not.toHaveProperty('bot_token');
        expect(result.has_bot_token).toBe(true);
        expect(result.enabled).toBe(true);
        expect(result.channels.leaves).toBe('#leaves');
    });

    it('returns has_bot_token=false when token is null', async () => {
        settingsMock.slack.bot_token = null;
        const result = await svc.getSlackSettings();
        expect(result.has_bot_token).toBe(false);
    });
});

// ─── patchSlackSettings ──────────────────────────────────────────────────

describe('patchSlackSettings', () => {
    it('updates enabled and persists', async () => {
        await svc.patchSlackSettings({ enabled: false }, makeCaller());
        expect(settingsMock.slack.enabled).toBe(false);
        expect(settingsMock.save).toHaveBeenCalledTimes(1);
    });

    it('clears bot_token when an empty string is supplied', async () => {
        await svc.patchSlackSettings({ bot_token: '' }, makeCaller());
        expect(settingsMock.slack.bot_token).toBeNull();
    });

    it('clears bot_token when null is supplied', async () => {
        await svc.patchSlackSettings({ bot_token: null }, makeCaller());
        expect(settingsMock.slack.bot_token).toBeNull();
    });

    it('J1 — encrypts the bot_token before storing, never landing the plaintext at rest', async () => {
        // Pre-J1 the stored value was verbatim plaintext. Post-J1 the stored
        // value is an AES-GCM envelope; the plaintext only exists in memory
        // long enough to be encrypted. We verify both halves of the contract:
        //   1. The stored value is NOT the plaintext input.
        //   2. The stored value round-trips back to the input under decrypt.
        await svc.patchSlackSettings({ bot_token: 'xoxb-new' }, makeCaller());
        const stored = settingsMock.slack.bot_token;
        expect(stored).not.toBeNull();
        expect(stored).not.toBe('xoxb-new');
        // Envelope shape — three base64url segments, optionally with a `kid:` prefix.
        expect(looksEncrypted(stored as string)).toBe(true);
        // Round-trip: decrypt the stored blob and confirm we get back the input.
        expect(decryptSecret(stored as string)).toBe('xoxb-new');
    });

    it('patchSlackSettings updates attendance_nudges and surfaces them', async () => {
        const result = await svc.patchSlackSettings(
            { attendance_nudges: { enabled: true, check_in_time: '10:30' } },
            { id: new Types.ObjectId() }
        );
        expect(result.attendance_nudges.enabled).toBe(true);
        expect(result.attendance_nudges.check_in_time).toBe('10:30');
        expect(result.attendance_nudges.checkout_reminder_time).toBe('20:00');
    });

    it('merges a partial channels update without clobbering siblings', async () => {
        await svc.patchSlackSettings({ channels: { leaves: '#hr-leaves' } }, makeCaller());
        expect(settingsMock.slack.channels.leaves).toBe('#hr-leaves');
        expect(settingsMock.slack.channels.attendance).toBe('#attendance');
    });

    it('records an audit row whose snapshots are ALWAYS redacted (no raw token leak)', async () => {
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };
        await svc.patchSlackSettings({ bot_token: 'xoxb-supersecret' }, caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0];
        const audit = payload as { before: Record<string, unknown>; after: Record<string, unknown> };
        // Both snapshots use `has_bot_token` instead of the raw value.
        expect(audit.before).not.toHaveProperty('bot_token');
        expect(audit.after).not.toHaveProperty('bot_token');
        expect(audit.before.has_bot_token).toBe(true);
        expect(audit.after.has_bot_token).toBe(true);
    });

    it('audit metadata flags bot_token_changed when the field was in the patch', async () => {
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };
        await svc.patchSlackSettings({ bot_token: 'xoxb-x' }, caller);
        const [, payload] = recordAuditMock.mock.calls[0];
        const meta = (payload as { metadata: { bot_token_changed: boolean } }).metadata;
        expect(meta.bot_token_changed).toBe(true);
    });

    it('audit metadata does NOT flag bot_token_changed when the patch only touched enabled', async () => {
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };
        await svc.patchSlackSettings({ enabled: false }, caller);
        const [, payload] = recordAuditMock.mock.calls[0];
        const meta = (payload as { metadata: { bot_token_changed: boolean; enabled_changed: boolean } }).metadata;
        expect(meta.bot_token_changed).toBe(false);
        expect(meta.enabled_changed).toBe(true);
    });
});

// ─── sendTestMessage ─────────────────────────────────────────────────────

describe('sendTestMessage', () => {
    it('throws 503 SLACK_NOT_CONFIGURED when slack.enabled is false', async () => {
        settingsMock.slack.enabled = false;
        await expect(svc.sendTestMessage({ channel: '#test' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SLACK_NOT_CONFIGURED,
            statusCode: 503,
        });
        expect(postSlackMessageMock).not.toHaveBeenCalled();
    });

    it('throws 503 SLACK_NOT_CONFIGURED when bot_token is null', async () => {
        settingsMock.slack.bot_token = null;
        await expect(svc.sendTestMessage({ channel: '#test' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.SLACK_NOT_CONFIGURED,
        });
    });

    it('returns delivered:true and audits when Slack accepts the message', async () => {
        // postSlackMessage now returns { success, ts?, channel? } (Phase 1 prereq).
        postSlackMessageMock.mockResolvedValueOnce({ success: true, ts: '1.1', channel: 'C1' });
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };
        const result = await svc.sendTestMessage({ channel: '#test' }, caller);
        expect(result).toEqual({ delivered: true, channel: '#test' });
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const meta = (recordAuditMock.mock.calls[0][1] as { metadata: { delivered: boolean } }).metadata;
        expect(meta.delivered).toBe(true);
    });

    it('throws 502 SLACK_DISPATCH_FAILED when Slack rejects the message — but still audits the failure', async () => {
        postSlackMessageMock.mockResolvedValueOnce({ success: false });
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };
        await expect(svc.sendTestMessage({ channel: '#bad' }, caller)).rejects.toMatchObject({
            code: ERROR_CODES.SLACK_DISPATCH_FAILED,
            statusCode: 502,
        });
        // Audit is recorded BEFORE the throw so the operator sees the
        // attempt with delivered:false in the trail.
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const meta = (recordAuditMock.mock.calls[0][1] as { metadata: { delivered: boolean } }).metadata;
        expect(meta.delivered).toBe(false);
    });

    it('uses the caller-supplied text when provided, else a default', async () => {
        postSlackMessageMock.mockResolvedValueOnce({ success: true, ts: '1.1', channel: 'C1' });
        await svc.sendTestMessage({ channel: '#x', text: 'hello world' }, makeCaller());
        expect(postSlackMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ text: 'hello world', channel: '#x' })
        );

        postSlackMessageMock.mockResolvedValueOnce({ success: true, ts: '1.1', channel: 'C1' });
        await svc.sendTestMessage({ channel: '#x' }, makeCaller());
        const call = postSlackMessageMock.mock.calls[1][1] as { text: string };
        expect(call.text).toContain('Viljetech Slack integration test');
    });
});

// ─── migratePlaintextSlackBotToken (J1) ─────────────────────────────────

describe('migratePlaintextSlackBotToken', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('encrypts a legacy plaintext token in place', async () => {
        const docId = new Types.ObjectId();
        systemSettingsFindOneMock.mockReturnValueOnce({
            select: () => Promise.resolve({ _id: docId, slack: { bot_token: 'xoxb-legacy-plaintext' } }),
        });
        systemSettingsUpdateOneMock.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 1 });

        const result = await svc.migratePlaintextSlackBotToken();
        expect(result.migrated).toBe(true);

        // The update is predicate-guarded on the LEGACY plaintext value so a
        // racing replica doesn't double-encrypt; the new value is the AES blob.
        expect(systemSettingsUpdateOneMock).toHaveBeenCalledWith(
            { _id: docId, 'slack.bot_token': 'xoxb-legacy-plaintext' },
            expect.objectContaining({ $set: expect.objectContaining({ 'slack.bot_token': expect.any(String) }) })
        );
        const call = systemSettingsUpdateOneMock.mock.calls[0]![1] as { $set: { 'slack.bot_token': string } };
        const newValue = call.$set['slack.bot_token'];
        expect(newValue).not.toBe('xoxb-legacy-plaintext');
        expect(looksEncrypted(newValue)).toBe(true);
        expect(decryptSecret(newValue)).toBe('xoxb-legacy-plaintext');
    });

    it('is a no-op when the stored token already looks encrypted (idempotent)', async () => {
        // Construct a real encrypted blob so `looksEncrypted` returns true.
        const { encryptSecret } = await import('../utils/crypto-aes.js');
        const alreadyEncrypted = encryptSecret('xoxb-already-migrated');
        systemSettingsFindOneMock.mockReturnValueOnce({
            select: () => Promise.resolve({ _id: new Types.ObjectId(), slack: { bot_token: alreadyEncrypted } }),
        });

        const result = await svc.migratePlaintextSlackBotToken();
        expect(result.migrated).toBe(false);
        expect(systemSettingsUpdateOneMock).not.toHaveBeenCalled();
    });

    it('is a no-op when bot_token is null (nothing to migrate)', async () => {
        systemSettingsFindOneMock.mockReturnValueOnce({
            select: () => Promise.resolve({ _id: new Types.ObjectId(), slack: { bot_token: null } }),
        });

        const result = await svc.migratePlaintextSlackBotToken();
        expect(result.migrated).toBe(false);
        expect(systemSettingsUpdateOneMock).not.toHaveBeenCalled();
    });

    it('does not block boot when the migration write fails (logs, continues)', async () => {
        systemSettingsFindOneMock.mockReturnValueOnce({
            select: () => Promise.resolve({ _id: new Types.ObjectId(), slack: { bot_token: 'xoxb-legacy' } }),
        });
        systemSettingsUpdateOneMock.mockRejectedValueOnce(new Error('mongo down'));

        // Must NOT throw — boot has to keep moving.
        await expect(svc.migratePlaintextSlackBotToken()).resolves.toEqual({ migrated: false });
    });
});
