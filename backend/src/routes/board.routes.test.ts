// Redesign: the board and the companies page in one request each, behind the same
// permissions as the per-project routes they replace.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { userFindByIdMock, settingsMock, loadBoardMock, loadDetailsMock } = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
    loadBoardMock: vi.fn(),
    loadDetailsMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({ User: { findById: userFindByIdMock } }));
vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({ failed_login_threshold: null, lockout_duration_minutes: null }),
}));
vi.mock('../services/board.service.js', () => ({ loadBoard: loadBoardMock, loadCompanyDetails: loadDetailsMock }));

const { buildTestApp } = await import('../integration/_helpers/build-app.js');
const app = buildTestApp();
const token = (permissions: string[], role = 'employee') =>
    jwt.sign({ user_id: new Types.ObjectId().toString(), role, role_keys: [role], permissions }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: '1h' });
const get = (path: string, permissions: string[], role?: string) =>
    request(app).get(`/api/v1${path}`).set({ Authorization: `Bearer ${token(permissions, role)}` });

beforeEach(() => {
    vi.resetAllMocks();
    userFindByIdMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }) });
    settingsMock.mockResolvedValue({ security: { mfa_required_for_admins: false } });
    loadBoardMock.mockResolvedValue([]);
    loadDetailsMock.mockResolvedValue({ stories: {}, contacts: {} });
});

describe('GET /board', () => {
    it('needs both project.read and task.read', async () => {
        expect((await get('/board', ['project.read', 'task.read'])).status).toBe(200);
        expect((await get('/board', ['project.read'])).status).toBe(403);
        expect(loadBoardMock).toHaveBeenCalledTimes(1);
    });
});

describe('GET /board/companies', () => {
    it("reads contacts only for a caller who may list them (company.read or representative.write)", async () => {
        await get('/board/companies', ['project.read', 'company.read']);
        await get('/board/companies', ['project.read', 'representative.write']);
        await get('/board/companies', ['project.read']);
        expect(loadDetailsMock.mock.calls.map((c) => c[1])).toEqual([true, true, false]);
        expect((await get('/board/companies', [])).status).toBe(403);
    });
});
