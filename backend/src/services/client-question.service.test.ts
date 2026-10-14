import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const m = vi.hoisted(() => ({
    qFind: vi.fn(),
    qFindOne: vi.fn(),
    qCreate: vi.fn(),
    rFind: vi.fn(),
    rFindOne: vi.fn(),
    rCreate: vi.fn(),
    taskFindById: vi.fn(),
    sprintFindById: vi.fn(),
    itemFindOne: vi.fn(),
    visible: vi.fn(),
    nameOf: vi.fn(),
}));

vi.mock('../models/client-question.model.js', () => ({ ClientQuestion: { find: m.qFind, findOne: m.qFindOne, create: m.qCreate } }));
vi.mock('../models/devops-request.model.js', () => ({ DevopsRequest: { find: m.rFind, findOne: m.rFindOne, create: m.rCreate } }));
vi.mock('../models/task.model.js', () => ({ Task: { findById: m.taskFindById } }));
vi.mock('../models/sprint.model.js', () => ({ Sprint: { findById: m.sprintFindById } }));
vi.mock('../models/devops-item.model.js', () => ({ DevopsItem: { findOne: m.itemFindOne } }));
vi.mock('./devops.service.js', () => ({
    visibleProjectIds: m.visible,
    nameOf: m.nameOf,
    isClientCaller: (c: { role: string }) => c.role === 'client' || c.role === 'representative',
}));

const svc = await import('./client-question.service.js');

const lean = <T>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const staff = () => ({ id: new Types.ObjectId(), role: 'employee' }) as never;
const client = () => ({ id: new Types.ObjectId(), role: 'client', company_id: new Types.ObjectId() }) as never;
const doc = <T extends object>(v: T) => {
    const d = { _id: new Types.ObjectId(), ...v, save: vi.fn(), markModified: vi.fn(), toObject: () => d };
    d.save.mockImplementation(async () => d);
    return d;
};

beforeEach(() => {
    vi.resetAllMocks();
    m.nameOf.mockResolvedValue('Arjun');
    m.visible.mockResolvedValue(null);
});

describe('questions', () => {
    it("lists only a client's company questions", async () => {
        const p = new Types.ObjectId();
        m.visible.mockResolvedValue([p]);
        m.qFind.mockReturnValue({ sort: () => lean([]) });
        await svc.listQuestions(client());
        expect(m.qFind).toHaveBeenCalledWith({ project_id: { $in: [p] } });
    });

    it('is raised by the team only', async () => {
        await expect(svc.createQuestion({ number: 1, title: 'DNS' }, client())).rejects.toMatchObject({ statusCode: 403 });
    });

    it("takes the project from the ticket, the DevOps item or the sprint, and refuses a taken number", async () => {
        const p = new Types.ObjectId();
        m.qFindOne.mockReturnValue(lean(null));
        m.qCreate.mockImplementation(async (v: object) => doc(v));
        m.taskFindById.mockReturnValue(lean({ project_id: p }));
        await svc.createQuestion({ number: 4, title: 'DNS', task_id: String(new Types.ObjectId()) }, staff());
        expect(m.qCreate).toHaveBeenLastCalledWith(expect.objectContaining({ number: 4, project_id: p, by: 'Arjun' }));

        m.itemFindOne.mockReturnValue(lean({ project_id: p }));
        await svc.createQuestion({ number: 5, title: 'DNS', devops_key: 'OPS-1' }, staff());
        expect(m.qCreate).toHaveBeenLastCalledWith(expect.objectContaining({ project_id: p, devops_key: 'OPS-1' }));

        m.sprintFindById.mockReturnValue(lean({ project_id: p }));
        await svc.createQuestion({ number: 6, title: 'DNS', sprint: `${new Types.ObjectId()}~epic` }, staff());
        expect(m.qCreate).toHaveBeenLastCalledWith(expect.objectContaining({ project_id: p }));

        m.qFindOne.mockReturnValue(lean({ number: 6 }));
        await expect(svc.createQuestion({ number: 6, title: 'DNS' }, staff())).rejects.toMatchObject({ statusCode: 409 });
    });

    it("writes a client's message as theirs, on the client side, whatever they send", async () => {
        const c = client();
        const p = new Types.ObjectId();
        m.visible.mockResolvedValue([p]);
        const q = doc({ number: 1, project_id: p, messages: [] as unknown[] });
        m.qFindOne.mockResolvedValue(q);
        await svc.addMessage(1, { text: 'Done', files: [] }, c);
        expect(q.messages[0]).toMatchObject({ who: 'Arjun', side: 'client', text: 'Done' });
    });

    it("hides a question of another company from a client", async () => {
        m.visible.mockResolvedValue([new Types.ObjectId()]);
        m.qFindOne.mockResolvedValue(doc({ number: 1, project_id: new Types.ObjectId(), messages: [] }));
        await expect(svc.addMessage(1, { text: 'x', files: [] }, client())).rejects.toMatchObject({ statusCode: 404 });
    });

    it("edits only the caller's own message", async () => {
        const me = staff();
        const q = doc({ number: 1, project_id: null, messages: [{ who: 'Raj', by_id: new Types.ObjectId(), side: 'team', text: 'a' }] });
        m.qFindOne.mockResolvedValue(q);
        await expect(svc.editMessage(1, 0, 'b', me)).rejects.toMatchObject({ statusCode: 403 });
        q.messages[0].by_id = (me as { id: Types.ObjectId }).id;
        await svc.editMessage(1, 0, 'b', me);
        expect(q.messages[0].text).toBe('b');
    });

    it('lets a client only mark solved or reopen', async () => {
        const p = new Types.ObjectId();
        m.visible.mockResolvedValue([p]);
        const q = doc({ number: 1, project_id: p, solved: false, title: 'DNS' });
        m.qFindOne.mockResolvedValue(q);
        await expect(svc.updateQuestion(1, { title: 'x' }, client())).rejects.toMatchObject({ statusCode: 403 });
        await svc.updateQuestion(1, { solved: true }, client());
        expect(q.solved).toBe(true);
    });
});

describe('question photos', () => {
    const img = (n: number) => ({ name: `p${n}.png`, size: '1 KB', url: 'data:image/png;base64,AA', img: true });

    it('appends only the new photos, up to 20 a question, for the team', async () => {
        const q = doc({ number: 1, project_id: null, photos: [img(1)] as unknown[] });
        m.qFindOne.mockResolvedValue(q);
        await svc.addPhotos(1, [img(2)], staff());
        expect(q.photos).toEqual([img(1), img(2)]);
        q.photos = Array.from({ length: 20 }, (_, i) => img(i));
        await expect(svc.addPhotos(1, [img(21)], staff())).rejects.toMatchObject({ statusCode: 422 });
        await expect(svc.addPhotos(1, [img(2)], client())).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('DevOps requests', () => {
    it('are raised by the team, on the DevOps item\'s project', async () => {
        await expect(svc.createRequest({ number: 1, devops_key: 'OPS-1', text: 'x' }, client())).rejects.toMatchObject({ statusCode: 403 });
        const p = new Types.ObjectId();
        m.itemFindOne.mockReturnValue(lean({ project_id: p }));
        m.rFindOne.mockReturnValue(lean(null));
        m.rCreate.mockImplementation(async (v: object) => doc(v));
        await svc.createRequest({ number: 1, devops_key: 'OPS-1', text: 'Need staging' }, staff());
        expect(m.rCreate).toHaveBeenCalledWith(expect.objectContaining({ number: 1, project_id: p, by: 'Arjun', status: 'Open' }));
    });

    it('logs a change under the caller and adds comments with their name', async () => {
        const r = doc({ number: 1, project_id: null, status: 'Open', history: [] as { by: string; text: string }[], comments: [] as { by: string; side: string }[] });
        m.rFindOne.mockResolvedValue(r);
        await svc.updateRequest(1, { patch: { status: 'Done' }, log: { text: 'Status changed to Done' } }, staff());
        expect(r.status).toBe('Done');
        expect(r.history[0]).toMatchObject({ by: 'Arjun', text: 'Status changed to Done' });
        await svc.addRequestComment(1, { text: 'Ready', side: 'devops' }, staff());
        expect(r.comments[0]).toMatchObject({ by: 'Arjun', side: 'devops', text: 'Ready' });
        await expect(svc.addRequestComment(1, { text: 'x', side: 'devops' }, client())).rejects.toMatchObject({ statusCode: 403 });
    });
});
