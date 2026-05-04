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
}
interface MockSettings {
    slack: MockSlack;
    _id: unknown;
    updated_by: unknown;
    save: ReturnType<typeof vi.fn>;
}

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

    it('stores a non-empty bot_token verbatim', async () => {
        await svc.patchSlackSettings({ bot_token: 'xoxb-new' }, makeCaller());
        expect(settingsMock.slack.bot_token).toBe('xoxb-new');
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
        postSlackMessageMock.mockResolvedValueOnce(true);
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
        postSlackMessageMock.mockResolvedValueOnce(false);
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
        postSlackMessageMock.mockResolvedValueOnce(true);
        await svc.sendTestMessage({ channel: '#x', text: 'hello world' }, makeCaller());
        expect(postSlackMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ text: 'hello world', channel: '#x' })
        );

        postSlackMessageMock.mockResolvedValueOnce(true);
        await svc.sendTestMessage({ channel: '#x' }, makeCaller());
        const call = postSlackMessageMock.mock.calls[1][1] as { text: string };
        expect(call.text).toContain('Viljetech Slack integration test');
    });
});
