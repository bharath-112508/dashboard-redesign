import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';

import { PERMISSIONS } from '../constants/permissions.js';

/**
 * Integration — Slack interactive → approveLeave round-trip.
 *
 * Validates the FULL middleware stack the production routes use:
 *   1. rate limiter (no-op at single-request volumes)
 *   2. raw-body capture + HMAC-SHA256 signature verify
 *   3. controller payload parse + action_id dispatch
 *   4. user resolver (slack_user_id → Viljetech user)
 *   5. permission gate (`leave_request.approve`, see `callerCanApproveLeave`)
 *   6. leave-request service call
 *
 * Mocks the leaf services (`approveLeave`, `User.findOne`/`findById`,
 * settings) so the test runs in-process without a Mongo connection —
 * matches the existing integration-test posture (see
 * `leaves-apply.integration.test.ts`). `User.findById` backs
 * `resolvePermissionsForUser` (role.service.js), which `callerCanApproveLeave`
 * calls — it's stubbed here to resolve straight from `extra_permissions`
 * (skipping the `role_ids` → `Role.find` join) so the test doesn't also need
 * to mock the Role model.
 */

const SIGNING_SECRET = 'test_slack_signing_secret_int';

vi.mock('../config/server.config.js', async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return { ...real, SLACK_SIGNING_SECRET: SIGNING_SECRET };
});

const {
    approveLeaveMock,
    rejectLeaveMock,
    findOneUserMock,
    findByIdUserMock,
    findByIdAndUpdateUserMock,
    settingsMock,
} = vi.hoisted(() => ({
    approveLeaveMock: vi.fn(),
    rejectLeaveMock: vi.fn(),
    findOneUserMock: vi.fn(),
    findByIdUserMock: vi.fn(),
    findByIdAndUpdateUserMock: vi.fn(),
    settingsMock: vi.fn(),
}));

vi.mock('../services/leave-request.service.js', () => ({
    approveLeave: approveLeaveMock,
    rejectLeave: rejectLeaveMock,
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findOne: findOneUserMock,
        findById: findByIdUserMock,
        findByIdAndUpdate: findByIdAndUpdateUserMock,
    },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
}));

const { buildTestApp } = await import('./_helpers/build-app.js');

/** `User.findById(...).select(...).lean()` — mirrors `resolvePermissionsForUser`'s
 *  chain. `role_ids: []` skips the `Role.find` join, so the resolved
 *  permission set is exactly `extraPermissions`. */
const permsQueryStub = (extraPermissions: string[]) => ({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue({ role_ids: [], extra_permissions: extraPermissions }),
});

const signed = (body: string) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = `v0=${crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
    return { ts, sig };
};

describe('Slack interactive → leave round-trip', () => {
    let managerId: Types.ObjectId;

    beforeEach(() => {
        approveLeaveMock.mockReset();
        rejectLeaveMock.mockReset();
        findOneUserMock.mockReset();
        findByIdUserMock.mockReset();
        findByIdAndUpdateUserMock.mockReset();
        settingsMock.mockReset();

        managerId = new Types.ObjectId();
        // Default caller (`manager`, below) holds `leave_request.approve`.
        findByIdUserMock.mockReturnValue(permsQueryStub([PERMISSIONS.LEAVE_REQUEST_APPROVE]));
        settingsMock.mockResolvedValue({
            slack: {
                enabled: true,
                bot_token: 'xoxb-test-token-int',
                channels: {
                    leaves: '#leaves',
                    attendance: '#attendance',
                    projects: '#projects',
                    timesheet: '#timesheet',
                    general: '#general',
                },
            },
        });
        // User.findOne (by slack_user_id) returns the manager directly.
        findOneUserMock.mockResolvedValue({
            _id: managerId,
            email: 'manager@example.com',
            role: 'manager',
            slack_user_id: 'U_MANAGER',
        });
    });

    it('rejects unsigned requests with 401', async () => {
        const app = buildTestApp();
        const res = await request(app)
            .post('/api/v1/slack/interactive')
            .set('Content-Type', 'application/json')
            .send('{}');
        expect(res.status).toBe(401);
        expect(approveLeaveMock).not.toHaveBeenCalled();
    });

    it('signed approve_leave payload → calls approveLeave + 200 within 3s contract', async () => {
        const app = buildTestApp();
        const leaveId = new Types.ObjectId().toString();
        approveLeaveMock.mockResolvedValueOnce({ status: 'approved' });

        const payload = {
            type: 'block_actions',
            user: { id: 'U_MANAGER' },
            actions: [{ action_id: `approve_leave_${leaveId}` }],
        };
        const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
        const { ts, sig } = signed(body);

        const res = await request(app)
            .post('/api/v1/slack/interactive')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .set('X-Slack-Signature', sig)
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(200);
        expect(approveLeaveMock).toHaveBeenCalledTimes(1);
        const [calledId, , caller] = approveLeaveMock.mock.calls[0];
        expect(String(calledId)).toBe(leaveId);
        expect(caller).toMatchObject({ id: managerId, role: 'manager' });
    });

    it('signed reject_leave payload → calls rejectLeave', async () => {
        const app = buildTestApp();
        const leaveId = new Types.ObjectId().toString();
        rejectLeaveMock.mockResolvedValueOnce({ status: 'rejected' });

        const payload = {
            type: 'block_actions',
            user: { id: 'U_MANAGER' },
            actions: [{ action_id: `reject_leave_${leaveId}` }],
        };
        const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
        const { ts, sig } = signed(body);

        const res = await request(app)
            .post('/api/v1/slack/interactive')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .set('X-Slack-Signature', sig)
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(200);
        expect(rejectLeaveMock).toHaveBeenCalledTimes(1);
    });

    it('signed but employee-role caller → ephemeral 403, no service call', async () => {
        const employeeId = new Types.ObjectId();
        findOneUserMock.mockReset();
        findOneUserMock.mockResolvedValue({
            _id: employeeId,
            email: 'employee@example.com',
            role: 'employee',
            slack_user_id: 'U_EMPLOYEE',
        });
        // Employee's resolved permissions don't include leave_request.approve.
        findByIdUserMock.mockReturnValue(permsQueryStub([]));

        const app = buildTestApp();
        const leaveId = new Types.ObjectId().toString();
        const payload = {
            type: 'block_actions',
            user: { id: 'U_EMPLOYEE' },
            actions: [{ action_id: `approve_leave_${leaveId}` }],
        };
        const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
        const { ts, sig } = signed(body);

        const res = await request(app)
            .post('/api/v1/slack/interactive')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .set('X-Slack-Signature', sig)
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
        expect(res.body.text).toMatch(/permission/i);
        expect(approveLeaveMock).not.toHaveBeenCalled();
    });
});
