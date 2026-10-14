import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { itemFind, itemFindOne, itemFindOneAndUpdate, itemCreate, projectFind, projectFindById, userFindById, settingsMock } = vi.hoisted(() => ({
    itemFind: vi.fn(),
    itemFindOne: vi.fn(),
    itemFindOneAndUpdate: vi.fn(),
    itemCreate: vi.fn(),
    projectFind: vi.fn(),
    projectFindById: vi.fn(),
    userFindById: vi.fn(),
    settingsMock: vi.fn(),
}));

vi.mock('../models/devops-item.model.js', () => ({ DevopsItem: { find: itemFind, findOne: itemFindOne, findOneAndUpdate: itemFindOneAndUpdate, create: itemCreate } }));
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

describe('what a client sees of a DevOps item', () => {
    it('only the status side: no notes, activity, owners or internal plans', async () => {
        const c = new Types.ObjectId();
        const p = new Types.ObjectId();
        projectFind.mockReturnValue(lean([{ _id: p }]));
        const data = { name: 'Portal', project: { kind: 'client', id: String(p) }, infra: 'Waiting', phase: 'Setup', deploy: 'Live', initDue: '2026-11-30', logs: [{ text: 'internal' }], pnotes: [{ text: 'secret' }], owner: 'Vivek', notes: { 1: { text: 'x' } } };
        itemFind.mockReturnValue({ sort: () => lean([{ key: 'OPS-1', project_id: p, data, updated_at: new Date() }]) });
        const [item] = await svc.listItems(client(c));
        expect(item.data).toEqual({ name: 'Portal', project: { kind: 'client', id: String(p) }, infra: 'Waiting', phase: 'Setup', deploy: 'Live', initDue: '2026-11-30' });
        itemFind.mockReturnValue({ sort: () => lean([{ key: 'OPS-1', project_id: p, data, updated_at: new Date() }]) });
        const [forStaff] = await svc.listItems(staff());
        expect(forStaff.data).toEqual(data);
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

    it('refuses a key taken at the same moment (unique index)', async () => {
        const p = new Types.ObjectId();
        projectFindById.mockReturnValue(lean({ _id: p }));
        itemFindOne.mockReturnValue(lean(null));
        itemCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
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
        itemFindOneAndUpdate.mockResolvedValue(d);
        await svc.updateItem('OPS-7', { patch: { initDue: '2027-01-01', devDue: '2027-02-02', prio: 'High' }, log: { type: 'Field change', text: 'Priority changed to High' } }, staff('admin'));
        // Only the changed fields are set, and the entry is added to the stored activity, so a
        // change someone else saves at the same moment is not undone.
        const [filter, update] = itemFindOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ key: 'OPS-7' });
        expect(update.$set).toMatchObject({ 'data.initDue': '2026-11-30', 'data.devDue': '2026-11-01', 'data.prio': 'High', 'data.updatedBy': 'Arjun' });
        expect(Object.keys(update.$set).some((k) => k === 'data' || k === 'data.logs')).toBe(false);
        expect(update.$push['data.logs']).toMatchObject({ $position: 0, $slice: 500 });
        expect(update.$push['data.logs'].$each[0]).toMatchObject({ type: 'Field change', text: 'Priority changed to High', by: 'Arjun' });
        expect(d.save).not.toHaveBeenCalled();
    });

    it('refuses a field name that is not a plain name', async () => {
        itemFindOne.mockResolvedValue(item({}));
        settingsMock.mockResolvedValue(settingsDoc());
        await expect(svc.updateItem('OPS-7', { patch: { 'a.b': 1 } }, staff('admin'))).rejects.toMatchObject({ statusCode: 422 });
        expect(itemFindOneAndUpdate).not.toHaveBeenCalled();
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

describe('applyLocks', () => {
    it('leaves the pinned dev dates alone on an edit that does not touch dev dates', () => {
        const cur = { dev: 'Build', devDues: { Build: '2026-11-01' } };
        expect(svc.applyLocks(cur, { prio: 'High' }, { lockDevDue: true })).toEqual({ prio: 'High' });
        expect(svc.applyLocks(cur, { devDue: '2027-01-01' }, { lockDevDue: true })).toEqual({ devDue: '2026-11-01', devDues: { Build: '2026-11-01' } });
    });
});
