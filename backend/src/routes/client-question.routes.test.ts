// Redesign: what a question message may carry. The author and side come from
// the token, so a body that tries to set them is refused before the service runs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { userFindByIdMock, settingsMock, addMessageMock } = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
    addMessageMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({ User: { findById: userFindByIdMock } }));
vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({ failed_login_threshold: null, lockout_duration_minutes: null }),
}));
vi.mock('../services/client-question.service.js', () => ({ addMessage: addMessageMock }));

const { buildTestApp } = await import('../integration/_helpers/build-app.js');
const app = buildTestApp();
const token = () =>
    jwt.sign({ user_id: new Types.ObjectId().toString(), role: 'employee', role_keys: ['employee'], permissions: [] }, process.env.JWT_SECRET ?? 'test-secret', {
        expiresIn: '1h',
    });

beforeEach(() => {
    vi.resetAllMocks();
    userFindByIdMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }) });
    settingsMock.mockResolvedValue({ security: { mfa_required_for_admins: false } });
    addMessageMock.mockResolvedValue({ number: 3 });
});

describe('POST /questions/:number/messages', () => {
    const send = (body: object) => request(app).post('/api/v1/questions/3/messages').set({ Authorization: `Bearer ${token()}` }).send(body);

    it('takes text and files', async () => {
        const res = await send({ text: 'Done', files: [] });
        expect(res.status).toBe(201);
        expect(addMessageMock).toHaveBeenCalledWith(3, { text: 'Done', files: [] }, expect.anything());
    });

    it('refuses a body that sets the side or the author', async () => {
        expect((await send({ text: 'x', files: [], side: 'team' })).status).toBe(400);
        expect((await send({ text: 'x', files: [], who: 'Admin' })).status).toBe(400);
        expect(addMessageMock).not.toHaveBeenCalled();
    });
});
