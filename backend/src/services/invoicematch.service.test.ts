import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const m = vi.hoisted(() => ({
    find: vi.fn(),
    upsert: vi.fn(),
    del: vi.fn(),
    projectFindById: vi.fn(),
    visible: vi.fn(),
    nameOf: vi.fn(),
}));

vi.mock('../models/invoicematch-decision.model.js', () => ({
    InvoicematchDecision: { find: m.find, findOneAndUpdate: m.upsert, deleteOne: m.del },
}));
vi.mock('../models/project.model.js', () => ({ Project: { findById: m.projectFindById } }));
vi.mock('./audit.service.js', () => ({ recordAudit: vi.fn() }));
vi.mock('./devops.service.js', () => ({ visibleProjectIds: m.visible, nameOf: m.nameOf }));

const svc = await import('./invoicematch.service.js');

const lean = <T>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const P = new Types.ObjectId();
const staff = () => ({ id: new Types.ObjectId(), role: 'employee' }) as never;
const client = () => ({ id: new Types.ObjectId(), role: 'client', company_id: new Types.ObjectId() }) as never;

beforeEach(() => {
    vi.resetAllMocks();
    m.nameOf.mockResolvedValue('Emma Lindqvist');
    m.visible.mockResolvedValue(null);
    m.projectFindById.mockReturnValue(lean({ _id: P, name: 'InvoiceMatch' }));
});

describe('InvoiceMatch decisions', () => {
    it('lists the decisions on the project', async () => {
        m.find.mockReturnValue(lean([{ no: 'INV-1', st: 'approved', note: '', by: 'Emma Lindqvist' }]));
        expect(await svc.listDecisions(String(P), staff())).toEqual([{ no: 'INV-1', st: 'approved', note: '', by: 'Emma Lindqvist' }]);
        expect(m.find).toHaveBeenCalledWith({ project_id: P });
    });

    it('saves a decision under the caller', async () => {
        m.upsert.mockReturnValue(lean({ no: 'INV-1', st: 'hold', note: 'Ask supplier', by: 'Emma Lindqvist' }));
        await svc.decide(String(P), 'INV-1', { st: 'hold', note: 'Ask supplier' }, staff());
        expect(m.upsert).toHaveBeenCalledWith(
            { project_id: P, no: 'INV-1' },
            expect.objectContaining({ $set: expect.objectContaining({ st: 'hold', note: 'Ask supplier', by: 'Emma Lindqvist' }) }),
            expect.objectContaining({ upsert: true })
        );
    });

    it('undoes a decision', async () => {
        await svc.undo(String(P), 'INV-1', staff());
        expect(m.del).toHaveBeenCalledWith({ project_id: P, no: 'INV-1' });
    });

    it("lets a client decide only on their own company's InvoiceMatch project", async () => {
        m.visible.mockResolvedValue([new Types.ObjectId()]);
        await expect(svc.decide(String(P), 'INV-1', { st: 'approved', note: '' }, client())).rejects.toMatchObject({ statusCode: 404 });
        m.visible.mockResolvedValue([P]);
        m.upsert.mockReturnValue(lean({ no: 'INV-1', st: 'approved', note: '', by: 'Emma Lindqvist' }));
        await expect(svc.decide(String(P), 'INV-1', { st: 'approved', note: '' }, client())).resolves.toBeTruthy();
    });

    it('refuses a project that is not InvoiceMatch', async () => {
        m.projectFindById.mockReturnValue(lean({ _id: P, name: 'Intranet' }));
        await expect(svc.listDecisions(String(P), staff())).rejects.toMatchObject({ statusCode: 404 });
    });
});
