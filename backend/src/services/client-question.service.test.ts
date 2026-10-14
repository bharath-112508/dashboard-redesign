import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const m = vi.hoisted(() => ({
    qFind: vi.fn(),
    qFindOne: vi.fn(),
    qCreate: vi.fn(),
    qUpdate: vi.fn(),
    rFind: vi.fn(),
    rFindOne: vi.fn(),
    rCreate: vi.fn(),
    rUpdate: vi.fn(),
    taskFindById: vi.fn(),
    sprintFindById: vi.fn(),
    itemFindOne: vi.fn(),
    visible: vi.fn(),
    nameOf: vi.fn(),
    audit: vi.fn(),
    loadProject: vi.fn(),
}));

vi.mock('../models/client-question.model.js', () => ({ ClientQuestion: { find: m.qFind, findOne: m.qFindOne, create: m.qCreate, findOneAndUpdate: m.qUpdate } }));
vi.mock('../models/devops-request.model.js', () => ({ DevopsRequest: { find: m.rFind, findOne: m.rFindOne, create: m.rCreate, findOneAndUpdate: m.rUpdate } }));
vi.mock('../models/task.model.js', () => ({ Task: { findById: m.taskFindById } }));
vi.mock('../models/sprint.model.js', () => ({ Sprint: { findById: m.sprintFindById } }));
vi.mock('../models/devops-item.model.js', () => ({ DevopsItem: { findOne: m.itemFindOne } }));
vi.mock('./devops.service.js', () => ({
    visibleProjectIds: m.visible,
    nameOf: m.nameOf,
    isClientCaller: (c: { role: string }) => c.role === 'client' || c.role === 'representative',
    canRunDevops: (c: { role: string; role_keys?: string[] }) => c.role === 'admin' || (c.role_keys ?? []).includes('devops'),
}));

vi.mock('./audit.service.js', () => ({ recordAudit: m.audit }));
vi.mock('./project.service.js', () => ({ loadProjectForCaller: m.loadProject }));

const svc = await import('./client-question.service.js');

const lean = <T>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const staff = () => ({ id: new Types.ObjectId(), role: 'employee' }) as never;
const client = () => ({ id: new Types.ObjectId(), role: 'client', company_id: new Types.ObjectId() }) as never;
const doc = <T extends object>(v: T) => {
    const d = { _id: new Types.ObjectId(), ...v, save: vi.fn(), markModified: vi.fn(), toObject: () => d };
    d.save.mockImplementation(async () => d);
    return d;
};

/** A Mongo-like findOneAndUpdate over the in-memory doc: the filter's conditions, then $set and $push. */
type Doc = Record<string, unknown>;
const at = (d: Doc, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Doc)[k]), d);
const put = (d: Doc, path: string, v: unknown) => {
    const keys = path.split('.');
    const last = keys.pop()!;
    (keys.reduce<unknown>((o, k) => (o as Doc)[k], d) as Doc)[last] = v;
};
const applyUpdate = (d: Doc | null, filter: Doc, update: { $set?: Doc; $push?: Record<string, { $each: unknown[]; $position?: number; $slice?: number }> }) => {
    if (!d) return null;
    for (const [k, want] of Object.entries(filter)) {
        if (k === 'number') continue;
        const v = at(d, k);
        const w = want as { $size?: number; $exists?: boolean; equals?: unknown };
        if (w && typeof w === 'object' && '$size' in w) { if (((v as unknown[]) ?? []).length !== w.$size) return null; }
        else if (w && typeof w === 'object' && '$exists' in w) { if ((v !== undefined) !== w.$exists) return null; }
        else if (!(v instanceof Types.ObjectId ? v.equals(want as Types.ObjectId) : v === want)) return null;
    }
    for (const [k, v] of Object.entries(update.$set ?? {})) put(d, k, v);
    for (const [k, p] of Object.entries(update.$push ?? {})) {
        const cur = (at(d, k) as unknown[]) ?? [];
        const next = p.$position === 0 ? [...p.$each, ...cur] : [...cur, ...p.$each];
        put(d, k, p.$slice ? next.slice(0, p.$slice) : next);
    }
    return d;
};

beforeEach(() => {
    vi.resetAllMocks();
    m.nameOf.mockResolvedValue('Arjun');
    m.visible.mockResolvedValue(null);
    // Writes are single atomic updates on the stored doc (whatever findOne gives), never a read-then-save.
    m.qUpdate.mockImplementation(async (f: Doc, u: never) => applyUpdate((await m.qFindOne()) as Doc, f, u));
    m.rUpdate.mockImplementation(async (f: Doc, u: never) => applyUpdate((await m.rFindOne()) as Doc, f, u));
});

describe('questions', () => {
    it("lists only a client's company questions", async () => {
        const p = new Types.ObjectId();
        m.visible.mockResolvedValue([p]);
        const sort = vi.fn(() => ({ limit: () => lean([{ number: 2 }, { number: 1 }]) }));
        m.qFind.mockReturnValue({ sort });
        const out = await svc.listQuestions(client());
        expect(m.qFind).toHaveBeenCalledWith({ project_id: { $in: [p] } });
        // The newest 2000, shown oldest first.
        expect(sort).toHaveBeenCalledWith({ number: -1 });
        expect(out.map((q) => q.number)).toEqual([1, 2]);
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
        // Only that message's text is written, so one posted meanwhile is kept.
        expect(m.qUpdate.mock.calls.at(-1)?.[1]).toEqual({ $set: { 'messages.0.text': 'b' } });
        expect(q.save).not.toHaveBeenCalled();
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

describe('audit trail', () => {
    const audited = () => ({ id: new Types.ObjectId(), role: 'employee', audit: { actor_id: 'x' } }) as never;
    const actions = () => m.audit.mock.calls.map((c) => [c[1].action, c[1].after.change]);

    it('records messages, message edits, photos and request comments', async () => {
        const me = audited();
        const q = doc({ number: 1, project_id: null, photos: [] as unknown[], messages: [] as { by_id: Types.ObjectId }[] });
        m.qFindOne.mockResolvedValue(q);
        await svc.addMessage(1, { text: 'a', files: [] }, me);
        await svc.editMessage(1, 0, 'b', me);
        await svc.addPhotos(1, [{ name: 'p.png' }], me);
        m.rFindOne.mockResolvedValue(doc({ number: 2, comments: [] as unknown[], history: [], logs: [] }));
        await svc.addRequestComment(2, { text: 'c', side: 'devops' }, me);
        expect(actions()).toEqual([
            ['client_question.update', 'message'],
            ['client_question.update', 'message_edit'],
            ['client_question.update', 'photos'],
            ['devops_request.update', 'comment'],
        ]);
        expect(q.save).not.toHaveBeenCalled();
    });
});

describe('request hours', () => {
    it("adds new hours to what the server has, and refuses a removal made on an out-of-date list", async () => {
        const r = doc({ number: 3, comments: [], history: [] as unknown[], logs: [{ h: 1, by: 'Raj' }] as unknown[] });
        m.rFindOne.mockResolvedValue(r);
        await svc.updateRequest(3, { patch: {}, add_logs: [{ h: 2, by: 'Arjun' }] }, staff());
        expect(r.logs).toEqual([{ h: 1, by: 'Raj' }, { h: 2, by: 'Arjun' }]);
        await expect(svc.updateRequest(3, { patch: { logs: [] }, logs_if_count: 1 }, staff())).rejects.toMatchObject({ statusCode: 409 });
        expect(r.logs).toHaveLength(2);
        await svc.updateRequest(3, { patch: { logs: [{ h: 2, by: 'Arjun' }] }, logs_if_count: 2 }, staff());
        expect(r.logs).toEqual([{ h: 2, by: 'Arjun' }]);
        expect(r.save).not.toHaveBeenCalled();
    });

    it('refuses a removal when hours were logged after the server was read (the check is part of the write)', async () => {
        const r = doc({ number: 3, comments: [], history: [] as unknown[], logs: [{ h: 1 }] as unknown[] });
        m.rFindOne.mockResolvedValue(r);
        // Someone logs between this request's read and its write.
        m.rUpdate.mockImplementationOnce(async (f: Doc, u: never) => {
            (r.logs as unknown[]).push({ h: 5 });
            return applyUpdate(r as unknown as Doc, f, u);
        });
        await expect(svc.updateRequest(3, { patch: { logs: [] }, logs_if_count: 1 }, staff())).rejects.toMatchObject({ statusCode: 409 });
        expect(r.logs).toEqual([{ h: 1 }, { h: 5 }]);
    });

    it('refuses new hours and a whole list in one change', async () => {
        m.rFindOne.mockResolvedValue(doc({ number: 3, comments: [], history: [], logs: [] }));
        await expect(svc.updateRequest(3, { patch: { logs: [] }, add_logs: [{ h: 1 }] }, staff())).rejects.toMatchObject({ statusCode: 422 });
    });
});

describe('limits', () => {
    it('stops a question chat and a request thread at 1000 entries', async () => {
        m.qFindOne.mockResolvedValue(doc({ number: 1, project_id: null, messages: Array(1000).fill({}) }));
        await expect(svc.addMessage(1, { text: 'x', files: [] }, staff())).rejects.toMatchObject({ statusCode: 422 });
        m.rFindOne.mockResolvedValue(doc({ number: 2, comments: Array(1000).fill({}), history: [], logs: [] }));
        await expect(svc.addRequestComment(2, { text: 'x', side: 'devops' }, staff())).rejects.toMatchObject({ statusCode: 422 });
    });

    it('keeps a request\'s newest 500 history lines and at most 2000 hour entries', async () => {
        const r = doc({ number: 3, comments: [], history: Array(500).fill({ text: 'old' }) as unknown[], logs: Array(2000).fill({ h: 1 }) as unknown[] });
        m.rFindOne.mockResolvedValue(r);
        await svc.updateRequest(3, { patch: {}, log: { text: 'new' } }, staff());
        expect(r.history).toHaveLength(500);
        expect(r.history[0]).toMatchObject({ text: 'new' });
        await expect(svc.updateRequest(3, { patch: {}, add_logs: [{ h: 1 }] }, staff())).rejects.toMatchObject({ statusCode: 422 });
    });
});

describe('question project', () => {
    it('lets DevOps engineers and admins start one on any DevOps item', async () => {
        m.qFindOne.mockReturnValue(lean(null));
        m.qCreate.mockImplementation(async (v: object) => doc(v));
        m.itemFindOne.mockReturnValue(lean({ project_id: new Types.ObjectId() }));
        m.loadProject.mockRejectedValue(Object.assign(new Error('Project not found'), { statusCode: 404 }));
        const devops = { id: new Types.ObjectId(), role: 'employee', role_keys: ['employee', 'devops'] } as never;
        await svc.createQuestion({ number: 8, title: 'DNS', devops_key: 'OPS-1' }, devops);
        expect(m.qCreate).toHaveBeenCalled();
    });

    it("refuses a ticket on a project the caller cannot open", async () => {
        m.qFindOne.mockReturnValue(lean(null));
        m.taskFindById.mockReturnValue(lean({ project_id: new Types.ObjectId() }));
        m.loadProject.mockRejectedValue(Object.assign(new Error('Project not found'), { statusCode: 404 }));
        await expect(svc.createQuestion({ number: 7, title: 'DNS', task_id: String(new Types.ObjectId()) }, staff())).rejects.toMatchObject({ statusCode: 404 });
        expect(m.qCreate).not.toHaveBeenCalled();
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

    it("gives a client a request without the team's comments, history and hour logs", async () => {
        const p = new Types.ObjectId();
        m.visible.mockResolvedValue([p]);
        const row = { number: 1, devops_key: 'OPS-1', project_id: p, text: 'Need staging', status: 'Open', comments: [{ by: 'Arjun', text: 'internal', when: new Date(), side: 'devops' }], history: [{ by: 'A', text: 't', when: new Date() }], logs: [{ h: 2 }] };
        m.rFind.mockReturnValue({ sort: () => ({ limit: () => lean([row]) }) });
        const [r] = await svc.listRequests(client());
        expect(r).toMatchObject({ number: 1, text: 'Need staging', status: 'Open', comments: [], history: [], logs: [] });
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
