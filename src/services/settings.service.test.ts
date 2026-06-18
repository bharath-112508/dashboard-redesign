import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { DEFAULT_BREAK_ALLOWANCE_MINUTES } from '../constants/attendance.js';

/**
 * Unit tests for `settings.service` — Step 25 hardening pass.
 *
 * The dedicated `/settings/slack` surface (covered by
 * `slack-settings.service.test.ts`) redacts `bot_token` to
 * `has_bot_token: bool` on every GET response and audit row. These
 * tests pin the SAME redaction on the **legacy** entry points:
 *
 *   - `GET /settings` (`getSettingsForCaller`) — even an admin must
 *     never see the raw token in the response. Bypassing the
 *     dedicated `/settings/slack` GET should not be a token-leak
 *     vector.
 *   - `PATCH /settings` (`patchSettings`) — the audit `before/after`
 *     snapshots must not capture the raw token either, so a Step-31
 *     audit-log reader cannot historically extract it.
 *
 * Anything that calls `settings.toJSON()` or `settings.slack.toObject()`
 * directly is the hazard surface; these tests assert the in-place
 * `redactSlackBotTokenInPlace` helper covers both flows.
 */

const { settingsDoc, recordAuditMock } = vi.hoisted(() => {
    const doc: {
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
        toJSON: ReturnType<typeof vi.fn>;
        markModified: ReturnType<typeof vi.fn>;
        save: ReturnType<typeof vi.fn>;
        updated_by: unknown;
        default_timezone: string;
    } = {
        slack: {
            enabled: true,
            bot_token: 'xoxb-supersecret',
            channels: {
                leaves: '#leaves',
                attendance: '#attendance',
                projects: '#projects',
                timesheet: '#timesheet',
                general: '#general',
            },
        },
        toJSON: vi.fn(),
        markModified: vi.fn(),
        save: vi.fn(),
        updated_by: null,
        default_timezone: 'Asia/Kolkata',
    };
    return { settingsDoc: doc, recordAuditMock: vi.fn() };
});

vi.mock('../models/system-settings.model.js', () => ({
    SystemSettings: {
        findOne: vi.fn(async () => settingsDoc),
        create: vi.fn(),
    },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./settings.service.js');
import { ROLES } from '../constants/roles.js';

beforeEach(() => {
    vi.clearAllMocks();
    settingsDoc.slack.enabled = true;
    settingsDoc.slack.bot_token = 'xoxb-supersecret';
    settingsDoc.slack.channels = {
        leaves: '#leaves',
        attendance: '#attendance',
        projects: '#projects',
        timesheet: '#timesheet',
        general: '#general',
    };

    // `toJSON` returns a deep-copy of the doc shape so each call gets a
    // fresh object the redaction can mutate without polluting later
    // tests.
    settingsDoc.toJSON.mockImplementation(() => ({
        singleton_key: 'system',
        slack: {
            ...settingsDoc.slack,
            channels: { ...settingsDoc.slack.channels },
        },
        company: { name: 'Viljetech' },
    }));
    settingsDoc.save.mockImplementation(async () => settingsDoc);
});

// ─── GET /settings — legacy redaction (Step-25 fix) ──────────────────────

describe('getSettingsForCaller', () => {
    it('NEVER returns the raw bot_token to an admin (regression — legacy GET leak)', async () => {
        const json = await svc.getSettingsForCaller(ROLES.ADMIN);
        const slack = json.slack as Record<string, unknown>;
        expect(slack).toBeDefined();
        expect(slack).not.toHaveProperty('bot_token');
        expect(slack.has_bot_token).toBe(true);
    });

    it('returns has_bot_token=false when no token is set (admin path)', async () => {
        settingsDoc.slack.bot_token = null;
        const json = await svc.getSettingsForCaller(ROLES.ADMIN);
        const slack = json.slack as Record<string, unknown>;
        expect(slack.has_bot_token).toBe(false);
        expect(slack).not.toHaveProperty('bot_token');
    });

    it('strips the entire slack section for non-admin callers (existing behaviour)', async () => {
        const json = await svc.getSettingsForCaller(ROLES.MANAGER);
        expect(json).not.toHaveProperty('slack');
    });
});

// ─── PATCH /settings — legacy audit redaction (Step-25 fix) ──────────────

describe('patchSettings (legacy audit redaction)', () => {
    it('writes redacted before/after snapshots when the slack section is touched', async () => {
        // Pre-existing slack.bot_token = 'xoxb-supersecret'. Patch
        // bumps to a new token; both before and after must record
        // `has_bot_token: true` and NEVER the raw value.
        const audit = {
            actor_id: new Types.ObjectId(),
            actor_role: 'admin' as const,
            ip: null,
            user_agent: null,
        };
        await svc.patchSettings({ slack: { bot_token: 'xoxb-different-secret' } }, new Types.ObjectId(), audit);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0];
        const auditRow = payload as { before: Record<string, unknown>; after: Record<string, unknown> };
        const beforeSlack = auditRow.before.slack as Record<string, unknown>;
        const afterSlack = auditRow.after.slack as Record<string, unknown>;
        expect(beforeSlack).not.toHaveProperty('bot_token');
        expect(afterSlack).not.toHaveProperty('bot_token');
        expect(beforeSlack.has_bot_token).toBe(true);
        expect(afterSlack.has_bot_token).toBe(true);
    });

    it('the legacy PATCH response also redacts bot_token (regression)', async () => {
        const result = await svc.patchSettings({ slack: { enabled: true } }, new Types.ObjectId());
        const slack = result.slack as Record<string, unknown>;
        expect(slack).not.toHaveProperty('bot_token');
        expect(slack.has_bot_token).toBe(true);
    });
});

// ─── AttendanceSettings.break_allowance_minutes default ───────────────────

describe('AttendanceSettings.break_allowance_minutes default', () => {
    it(`schema default equals DEFAULT_BREAK_ALLOWANCE_MINUTES (${DEFAULT_BREAK_ALLOWANCE_MINUTES})`, async () => {
        // Bypass the vi.mock above by importing the real model module.
        // Mongoose models can be re-registered safely inside a vi.mock
        // context because vi.importActual bypasses module mocks.
        const { SystemSettings } = await vi.importActual<typeof import('../models/system-settings.model.js')>(
            '../models/system-settings.model.js'
        );
        const schemaPath = SystemSettings.schema.path('attendance.break_allowance_minutes');
        expect(schemaPath).toBeDefined();

        expect((schemaPath as { options: { default?: unknown } }).options.default).toBe(
            DEFAULT_BREAK_ALLOWANCE_MINUTES
        );
    });
});
