import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const m = vi.hoisted(() => ({
    listProjects: vi.fn(),
    listProjectMembers: vi.fn(),
    listCustomStatuses: vi.fn(),
    listStories: vi.fn(),
    listSprints: vi.fn(),
    listTasks: vi.fn(),
    listCompanies: vi.fn(),
    listRepresentatives: vi.fn(),
}));

vi.mock('./project.service.js', () => ({ listProjects: m.listProjects, listProjectMembers: m.listProjectMembers, listCustomStatuses: m.listCustomStatuses }));
vi.mock('./story.service.js', () => ({ listStories: m.listStories }));
vi.mock('./sprint.service.js', () => ({ listSprints: m.listSprints }));
vi.mock('./task.service.js', () => ({ listTasks: m.listTasks }));
vi.mock('./company.service.js', () => ({ listCompanies: m.listCompanies, listRepresentatives: m.listRepresentatives }));

const { loadBoard, loadCompanyDetails } = await import('./board.service.js');

const caller = { id: new Types.ObjectId(), role: 'employee' } as never;
const id = () => new Types.ObjectId().toString();
const page = <T>(data: T[]) => ({ data, meta: {} });

beforeEach(() => {
    vi.resetAllMocks();
    m.listStories.mockResolvedValue(page([{ id: 's1' }]));
    m.listSprints.mockResolvedValue(page([]));
    m.listCustomStatuses.mockResolvedValue({ defaults: [], custom: [] });
    m.listProjectMembers.mockResolvedValue([{ id: 'u1', full_name: 'Rahul' }]);
    m.listTasks.mockResolvedValue(page([]));
});

describe('loadBoard', () => {
    it("gives each live project's epics, sprints, statuses, members and every page of tickets in one answer", async () => {
        const [p1, p2] = [id(), id()];
        m.listProjects.mockResolvedValue(page([{ id: p1, is_archived: false }, { id: p2, is_archived: true }]));
        const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` }));
        m.listTasks.mockResolvedValueOnce(page(hundred)).mockResolvedValueOnce(page([{ id: 't100' }]));
        const board = await loadBoard(caller);
        expect(board).toHaveLength(1);
        expect(board[0]).toMatchObject({ project: { id: p1 }, stories: [{ id: 's1' }], members: [{ id: 'u1' }], statuses: { custom: [] } });
        expect(board[0].tasks).toHaveLength(101);
        // The same queries the app sent: its project, 100 a page.
        expect(m.listTasks.mock.calls.map((c) => [c[0].project_id, c[0].page, c[0].limit])).toEqual([
            [p1, 1, 100],
            [p1, 2, 100],
        ]);
    });

    it('leaves out a project that cannot be read instead of failing the whole board', async () => {
        const [p1, p2] = [id(), id()];
        m.listProjects.mockResolvedValue(page([{ id: p1, is_archived: false }, { id: p2, is_archived: false }]));
        m.listSprints.mockImplementation(async (pid: Types.ObjectId) => {
            if (pid.toString() === p1) throw new Error('gone');
            return page([]);
        });
        const board = await loadBoard(caller);
        expect(board.map((b) => b.project.id)).toEqual([p2]);
    });
});

describe('loadCompanyDetails', () => {
    it("gives each company project's epics and, when the caller may list them, each company's contacts", async () => {
        const [p1, c1] = [id(), id()];
        m.listProjects.mockResolvedValue(page([{ id: p1, is_archived: false, company_id: c1 }, { id: id(), is_archived: false, company_id: null }]));
        m.listCompanies.mockResolvedValue(page([{ id: c1 }]));
        m.listRepresentatives.mockResolvedValue(page([{ id: 'k1' }]));
        expect(await loadCompanyDetails(caller, true)).toEqual({ stories: { [p1]: [{ id: 's1' }] }, contacts: { [c1]: [{ id: 'k1' }] } });
        expect(m.listStories).toHaveBeenCalledTimes(1);
        m.listCompanies.mockClear();
        expect(await loadCompanyDetails(caller, false)).toEqual({ stories: { [p1]: [{ id: 's1' }] }, contacts: {} });
        expect(m.listCompanies).not.toHaveBeenCalled();
    });
});
