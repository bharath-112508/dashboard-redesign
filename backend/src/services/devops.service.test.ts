import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { itemFind, itemFindOne, itemCreate, projectFind, projectFindById, userFindById, settingsMock } = vi.hoisted(() => ({
    itemFind: vi.fn(),
    itemFindOne: vi.fn(),
    itemCreate: vi.fn(),
    projectFind: vi.fn(),
    projectFindById: vi.fn(),
    userFindById: vi.fn(),
    settingsMock: vi.fn(),
}));

vi.mock('../models/devops-item.model.js', () => ({ DevopsItem: { find: itemFind, findOne: itemFindOne, create: itemCreate } }));
vi.mock('../models/project.model.js', () => ({ Project: { find: projectFind, findById: projectFindById } }));
vi.mock('../models/user.model.js', () => ({ User: { findById: userFindById } }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: settingsMock }));

const svc = await import('./devops.service.js');

const lean = <T>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const staff = (role = 'employee', role_keys: string[] = []) => ({ id: new Types.ObjectId(), role, role_keys }) as never;
const client = (company: Types.ObjectId) => ({ id: new Types.ObjectId(), role: 'client', company_id: company }) as never;
const settingsDoc = (devops_settings: unknown = null) => {
    const d = { devops_settings, save: vi.fn(), markModified: vi.fn() };
    d.save.mockImplementation(async () => d);
    return d;
};

beforeEach(() => {
    vi.resetAllMocks();
    userFindById.mockReturnValue(lean({ full_name: 'Arjun' }));
});

describe('visibleProjectIds', () => {
    it('is everything (null) for staff', async () => {
        expect(await svc.visibleProjectIds(staff())).toBeNull();
    });

    it("is the client company's projects for a client, and only assigned ones for a representative", async () => {
        const c = new Types.ObjectId();
        const p = new Types.ObjectId();
        projectFind.mockReturnValue(lean([{ _id: p }]));
        expect(await svc.visibleProjectIds(client(c))).toEqual([p]);
        expect(projectFind).toHaveBeenLastCalledWith({ company_id: c });
        const rep = { id: new Types.ObjectId(), role: 'representative', company_id: c } as never;
        await svc.visibleProjectIds(rep);
        expect(projectFind).toHaveBeenLastCalledWith({ company_id: c, representative_ids: (rep as { id: unknown }).id });
    });
});

describe('listItems', () => {
    it("lists a client's items by their projects only", async () => {
        const c = new Types.ObjectId();
        const p = new Types.ObjectId();
        projectFind.mockReturnValue(lean([{ _id: p }]));
        itemFind.mockReturnValue({ sort: () => lean([]) });
        await svc.listItems(client(c));
        expect(itemFind).toHaveBeenCalledWith({ project_id: { $in: [p] } });
    });
});

describe('createItem', () => {
    const body = (p: Types.ObjectId) => ({ key: 'OPS-7', project_id: String(p), data: { name: 'Intranet', infra: 'Not started' } });

    it('is refused for a developer', async () => {
        await expect(svc.createItem(body(new Types.ObjectId()), staff())).rejects.toMatchObject({ statusCode: 403 });
    });

    it('is refused when the key is taken', async () => {
        const p = new Types.ObjectId();
        projectFindById.mockReturnValue(lean({ _id: p }));
        itemFindOne.mockReturnValue(lean({ key: 'OPS-7' }));
        await expect(svc.createItem(body(p), staff('employee', ['devops']))).rejects.toMatchObject({ statusCode: 409 });
    });

    it('saves the item for DevOps', async () => {
        const p = new Types.ObjectId();
        projectFindById.mockReturnValue(lean({ _id: p }));
        itemFindOne.mockReturnValue(lean(null));
        itemCreate.mockImplementation(async (v: object) => ({ toObject: () => v, ...v }));
        const out = await svc.createItem(body(p), staff('employee', ['devops']));
        expect(itemCreate).toHaveBeenCalledWith(expect.objectContaining({ key: 'OPS-7', project_id: p, data: { name: 'Intranet', infra: 'Not started' } }));
        expect(out).toMatchObject({ key: 'OPS-7', project_id: String(p) });
    });
});

describe('updateItem', () => {
    const item = (data: object) => {
        const d = { key: 'OPS-7', project_id: new Types.ObjectId(), data, save: vi.fn(), markModified: vi.fn(), toObject: () => d };
        d.save.mockImplementation(async () => d);
        return d;
    };

    it('keeps locked dates, merges the rest and logs the change under the caller', async () => {
        const d = item({ initDue: '2026-11-30', dev: 'Build', devDues: { Build: '2026-11-01' }, logs: [{ type: 'Note', text: 'old', by: 'X', when: 'w' }] });
        itemFindOne.mockResolvedValue(d);
        settingsMock.mockResolvedValue(settingsDoc({ rules: { lockInitial: true, lockDevDue: true } }));
        await svc.updateItem('OPS-7', { patch: { initDue: '2027-01-01', devDue: '2027-02-02', prio: 'High' }, log: { type: 'Field change', text: 'Priority changed to High' } }, staff('admin'));
        expect(d.data).toMatchObject({ initDue: '2026-11-30', devDue: '2026-11-01', prio: 'High', updatedBy: 'Arjun' });
        expect((d.data as { logs: unknown[] }).logs[0]).toMatchObject({ type: 'Field change', text: 'Priority changed to High', by: 'Arjun' });
        expect((d.data as { logs: unknown[] }).logs).toHaveLength(2);
        expect(d.save).toHaveBeenCalled();
    });

    it('is refused for a client', async () => {
        await expect(svc.updateItem('OPS-7', { patch: {} }, client(new Types.ObjectId()))).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('settings', () => {
    it('reads null until saved, and saving needs DevOps or admin', async () => {
        settingsMock.mockResolvedValue(settingsDoc());
        expect(await svc.getDevopsSettings()).toBeNull();
        await expect(svc.setDevopsSettings({ ladder: [] }, staff())).rejects.toMatchObject({ statusCode: 403 });
        const doc = settingsDoc();
        settingsMock.mockResolvedValue(doc);
        expect(await svc.setDevopsSettings({ ladder: [] }, staff('employee', ['devops']))).toEqual({ ladder: [] });
        expect(doc.devops_settings).toEqual({ ladder: [] });
    });
});
