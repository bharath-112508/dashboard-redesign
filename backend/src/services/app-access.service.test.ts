import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { settingsMock, auditMock } = vi.hoisted(() => ({ settingsMock: vi.fn(), auditMock: vi.fn() }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: settingsMock }));
vi.mock('./audit.service.js', () => ({ recordAudit: auditMock }));

const svc = await import('./app-access.service.js');

const doc = (app_access?: unknown) => {
    const d = { _id: new Types.ObjectId(), app_access, save: vi.fn(), markModified: vi.fn() };
    d.save.mockImplementation(async () => d);
    return d;
};

beforeEach(() => {
    vi.resetAllMocks();
});

describe('getAppAccess', () => {
    it('is empty until someone saves the grid', async () => {
        settingsMock.mockResolvedValueOnce(doc());
        expect(await svc.getAppAccess()).toEqual({ perms: null, dev_types: null });
    });

    it('returns what was saved', async () => {
        settingsMock.mockResolvedValueOnce(doc({ perms: { dev: ['tk.edit'] }, dev_types: ['Backend'] }));
        expect(await svc.getAppAccess()).toEqual({ perms: { dev: ['tk.edit'] }, dev_types: ['Backend'] });
    });
});

describe('setAppAccess', () => {
    it('saves the grid and the developer types, keeping a part that was not sent', async () => {
        const d = doc({ perms: { dev: ['tk.edit'] }, dev_types: ['Backend'] });
        settingsMock.mockResolvedValueOnce(d);
        const out = await svc.setAppAccess({ dev_types: ['Backend', 'QA'] }, { id: new Types.ObjectId(), role: 'admin', audit: undefined } as never);
        expect(out).toEqual({ perms: { dev: ['tk.edit'] }, dev_types: ['Backend', 'QA'] });
        expect(d.save).toHaveBeenCalled();
    });

    it('saves one role\'s ticks without touching the other roles', async () => {
        const d = doc({ perms: { dev: ['tk.edit'], pm: ['pr.plan'] }, dev_types: null });
        settingsMock.mockResolvedValueOnce(d);
        const out = await svc.setAppAccess({ perms: { pm: ['pr.plan', 'ts.all'] } }, { id: new Types.ObjectId(), role: 'admin', audit: undefined } as never);
        expect(out.perms).toEqual({ dev: ['tk.edit'], pm: ['pr.plan', 'ts.all'] });
    });
});
