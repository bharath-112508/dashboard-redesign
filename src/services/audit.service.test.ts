import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS, AUDIT_SNAPSHOT_BYTES_MAX } from '../constants/audit.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Unit tests for the audit-log dispatcher (Step 12).
 *
 * The audit service is the only piece of Step-12 plumbing with logic that
 * deserves a unit test: snapshot coercion, oversized-snapshot guarding, and
 * the never-throw contract. The integration into user/auth/mfa/leave/settings
 * services is exercised through the existing smoke tests for those domains
 * (per the user's "normal flow testing" scope — no new dedicated audit smoke).
 *
 * We mock:
 *   - `AuditLog.create` — the only DB call the service makes.
 *   - `logger.warn`     — the never-throw error sink.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────
//
// `vi.mock` factories are hoisted to the top of the file BEFORE module-level
// const declarations. To share mock fn references with the test body we
// declare them inside `vi.hoisted` so vitest hoists the bindings together
// with the factory.

const { auditCreateMock, loggerWarnMock } = vi.hoisted(() => {
    return {
        auditCreateMock: vi.fn(),
        loggerWarnMock: vi.fn(),
    };
});

vi.mock('../models/audit-log.model.js', () => ({
    AuditLog: {
        create: auditCreateMock,
    },
}));

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn() },
}));

// Pull the SUT after mocks are wired so it picks up the test doubles.
const audit = await import('./audit.service.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────

const actorId = new Types.ObjectId();
const targetId = new Types.ObjectId();

const baseCtx: import('./audit.service.js').AuditContext = {
    actor_id: actorId,
    actor_role: ROLES.ADMIN,
    ip: '203.0.113.10',
    user_agent: 'Mozilla/5.0 (vitest)',
};

beforeEach(() => {
    auditCreateMock.mockReset();
    loggerWarnMock.mockReset();
    auditCreateMock.mockResolvedValue({});
});

// ─── Happy-path writes ──────────────────────────────────────────────────

describe('recordAudit — basic shape', () => {
    it('writes a single row with actor + IP/UA folded into metadata', async () => {
        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.USER_DEACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: targetId },
            before: { status: 'active' },
            after: { status: 'deactivated' },
            metadata: { reason: 'left org' },
        });

        expect(auditCreateMock).toHaveBeenCalledTimes(1);
        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actor_id).toBe(actorId);
        expect(arg.actor_role).toBe(ROLES.ADMIN);
        expect(arg.action).toBe(AUDIT_ACTIONS.USER_DEACTIVATE);
        expect(arg.target_entity).toEqual({ kind: AUDIT_TARGET_KINDS.USER, id: targetId });
        expect(arg.before).toEqual({ status: 'active' });
        expect(arg.after).toEqual({ status: 'deactivated' });
        expect(arg.metadata).toEqual({
            ip: '203.0.113.10',
            user_agent: 'Mozilla/5.0 (vitest)',
            reason: 'left org',
        });
        expect(loggerWarnMock).not.toHaveBeenCalled();
    });

    it('omits ip + user_agent from metadata when context has them as null', async () => {
        await audit.recordAudit(
            { actor_id: actorId, actor_role: ROLES.MANAGER, ip: null, user_agent: null },
            {
                action: AUDIT_ACTIONS.LEAVE_REJECT,
                target: { kind: AUDIT_TARGET_KINDS.LEAVE_REQUEST, id: targetId },
            }
        );

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.metadata).toEqual({});
    });

    it('accepts a null target id (singleton resources e.g. system_settings)', async () => {
        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.SETTINGS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: null },
            after: { default_timezone: 'Asia/Kolkata' },
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.target_entity).toEqual({
            kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS,
            id: null,
        });
    });
});

// ─── Snapshot coercion ──────────────────────────────────────────────────

describe('recordAudit — snapshot coercion', () => {
    it('passes plain JSON snapshots through unchanged', async () => {
        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: targetId },
            before: { role: ROLES.EMPLOYEE, nested: { foo: 'bar' } },
            after: { role: ROLES.MANAGER, nested: { foo: 'baz' } },
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.before).toEqual({ role: ROLES.EMPLOYEE, nested: { foo: 'bar' } });
        expect(arg.after).toEqual({ role: ROLES.MANAGER, nested: { foo: 'baz' } });
    });

    it('reduces objects with toJSON() (mongoose-like) to their serialised form', async () => {
        const docLike = {
            toJSON: () => ({ id: 'abc', name: 'mocked' }),
            internal: 'should-not-appear',
        };

        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.USER_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: targetId },
            after: docLike as unknown as Record<string, unknown>,
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.after).toEqual({ id: 'abc', name: 'mocked' });
        expect(arg.after).not.toHaveProperty('internal');
    });

    it('drops oversized snapshots and flags them in metadata', async () => {
        // ~32 KiB string is well past the 16 KiB cap.
        const huge = 'x'.repeat(AUDIT_SNAPSHOT_BYTES_MAX * 2);

        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.SETTINGS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: null },
            before: { blob: huge },
            after: { blob: 'small' },
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.before).toBeNull();
        expect(arg.after).toEqual({ blob: 'small' });
        const metadata = arg.metadata as Record<string, unknown>;
        expect(metadata.before_snapshot_dropped).toBe(true);
        expect(metadata.after_snapshot_dropped).toBeUndefined();
    });

    it('G4 — preserves the snapshot-drop flags across the metadata-strip carve-out', async () => {
        // Both snapshots over the cap (so both flags fire), AND a giant
        // chunk of caller-supplied metadata so the metadata itself is
        // also oversized — exercising the strip carve-out.
        const huge = 'x'.repeat(AUDIT_SNAPSHOT_BYTES_MAX * 2);
        const hugeMeta = 'y'.repeat(AUDIT_SNAPSHOT_BYTES_MAX * 8);

        await audit.recordAudit(baseCtx, {
            action: AUDIT_ACTIONS.SETTINGS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: null },
            before: { blob: huge },
            after: { blob: huge },
            metadata: { caller_supplied: hugeMeta },
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        const metadata = arg.metadata as Record<string, unknown>;
        // Strip carve-out fired (caller_supplied was huge):
        expect(metadata.metadata_truncated).toBe(true);
        expect(metadata.caller_supplied).toBeUndefined();
        // …but the snapshot-drop flags MUST survive.
        expect(metadata.before_snapshot_dropped).toBe(true);
        expect(metadata.after_snapshot_dropped).toBe(true);
    });
});

// ─── Never-throw contract ──────────────────────────────────────────────

describe('recordAudit — never-throw contract', () => {
    it('swallows AuditLog.create rejections and logs at warn with AUDIT_WRITE_FAILED', async () => {
        auditCreateMock.mockRejectedValueOnce(new Error('mongo down'));

        await expect(
            audit.recordAudit(baseCtx, {
                action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGE,
                target: { kind: AUDIT_TARGET_KINDS.USER, id: targetId },
            })
        ).resolves.toBeUndefined();

        expect(loggerWarnMock).toHaveBeenCalledTimes(1);
        const [logCtx, message] = loggerWarnMock.mock.calls[0];
        const ctx = logCtx as Record<string, unknown>;
        expect(ctx.code).toBe(ERROR_CODES.AUDIT_WRITE_FAILED);
        expect(ctx.action).toBe(AUDIT_ACTIONS.AUTH_PASSWORD_CHANGE);
        expect(ctx.target_kind).toBe(AUDIT_TARGET_KINDS.USER);
        expect(ctx.target_id).toBe(targetId.toString());
        expect(ctx.actor_id).toBe(actorId.toString());
        expect(ctx.err).toBeInstanceOf(Error);
        expect(message).toMatch(/audit log write failed/i);
    });

    it('still resolves cleanly when the logger itself blows up (defence in depth)', async () => {
        auditCreateMock.mockRejectedValueOnce(new Error('boom'));
        loggerWarnMock.mockImplementationOnce(() => {
            throw new Error('logger broken too');
        });

        // The service wraps the warn call in its own try/catch so even a
        // misbehaving logger cannot propagate to the calling business action.
        await expect(
            audit.recordAudit(baseCtx, {
                action: AUDIT_ACTIONS.USER_CREATE,
                target: { kind: AUDIT_TARGET_KINDS.USER, id: targetId },
            })
        ).resolves.toBeUndefined();

        expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    });
});

// ─── recordSystemAudit ─────────────────────────────────────────────────

describe('recordSystemAudit', () => {
    it('records actor as system with no IP/UA', async () => {
        await audit.recordSystemAudit({
            action: 'job.attendance_finalize',
            target: { kind: 'system_settings', id: null },
            metadata: { run_id: 'r-001' },
        });

        const arg = auditCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actor_id).toBeNull();
        expect(arg.actor_role).toBe('system');
        expect(arg.action).toBe('job.attendance_finalize');
        const metadata = arg.metadata as Record<string, unknown>;
        expect(metadata.ip).toBeUndefined();
        expect(metadata.user_agent).toBeUndefined();
        expect(metadata.run_id).toBe('r-001');
    });
});
