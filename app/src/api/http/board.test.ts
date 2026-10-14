import { beforeEach, describe, expect, it, vi } from 'vitest'
import { boardFromRoutes } from './boardRoutes.testkit'
import type { Session } from '../types'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get } }))

const { fetchTasks, fetchWorkspace, loadBoard } = await import('./board')

const staff: Session = { personId: 'a0', name: 'Admin', email: 'a@x', role: 'super', org: 'Viljetech' }

const project = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  code,
  name: `Project ${id}`,
  status: 'active',
  is_archived: false,
  start_date: '2026-09-01',
  end_date: null,
  member_ids: [],
  company_id: 'c1',
  ...extra,
})

const task = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 'p1',
  task_number: n,
  sprint_id: null,
  story_id: 'e1',
  parent_task_id: null,
  title: `Task ${id}`,
  description: '',
  status: 'to_do',
  priority: 'medium',
  issue_type: 'task',
  labels: [],
  due_date: null,
  start_date: null,
  estimated_hours: 0,
  assignee_ids: ['u1'],
  primary_assignee_id: 'u1',
  collaborator_ids: [],
  source: null,
  depends_on_task_ids: [],
  created_at: '2026-10-07T09:00:00.000Z',
  ...extra,
})

const sprint = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 'p1',
  name: `Sprint ${id}`,
  goal: '',
  start_date: '2026-10-05',
  end_date: '2026-10-16',
  status: 'active',
  story_id: null,
  member_ids: [],
  goals: [],
  goals_done: [],
  summary: '',
  why: '',
  ...extra,
})

const NO_STATUSES = { defaults: [], custom: [] }

/**
 * Answers each path from a table; unknown paths fail the test. `GET /board` is built from the
 * table's per-project reads, as the backend builds it from the same routes' services.
 */
const serve = (routes: Record<string, unknown>) =>
  get.mockImplementation(async (path: string) => {
    if (path === '/board') return boardFromRoutes(routes)
    if (!(path in routes)) throw new Error(`unexpected call ${path}`)
    return routes[path]
  })

const p1Routes = (tasks: unknown[], sprints: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  '/projects?limit=100&page=1': [project('p1', 'AFSP')],
  '/projects/p1/stories?limit=100&page=1': [{ id: 'e1', project_id: 'p1', title: 'Web app' }, { id: 'e2', project_id: 'p1', title: 'Mobile' }],
  '/projects/p1/sprints?limit=100&page=1': sprints,
  '/projects/p1/custom-statuses': NO_STATUSES,
  '/projects/p1/members': [{ id: 'u1', full_name: 'Chary' }],
  '/tasks?project_id=p1&limit=100&page=1': tasks,
  ...extra,
})

describe('loadBoard', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('gives the default statuses, then each custom one', async () => {
    serve(p1Routes([], [], { '/projects/p1/custom-statuses': { defaults: [], custom: [{ id: 'x', key: 'qa', label: 'QA', order: 5, is_terminal: false, is_active: true }] } }))
    const { workspace } = await loadBoard(staff)
    expect(workspace.statuses.map(s => [s.id, s.name])).toEqual([
      ['todo', 'To do'],
      ['prog', 'In progress'],
      ['review', 'Review'],
      ['done', 'Done'],
      ['qa', 'QA'],
    ])
    expect(workspace.devopsLinks).toEqual({})
  })

  it('lists the stories as epics, plus "No epic" for a project with tasks outside any story', async () => {
    serve(p1Routes([task('t1', 1), task('t2', 2, { story_id: null })]))
    const { workspace, tasks, index } = await loadBoard(staff)
    expect(workspace.epics.map(e => [e.id, e.name])).toEqual([
      ['e1', 'Web app'],
      ['e2', 'Mobile'],
      ['none~p1', 'No epic'],
    ])
    expect(tasks.find(t => t.id === 't2')?.epic).toBe('none~p1')
    expect(index.projectOfEpic.get('none~p1')).toBe('p1')
    expect(index.storyOfEpic.get('none~p1')).toBeNull()
    expect(index.storyOfEpic.get('e1')).toBe('e1')
    expect(index.projectOfTask.get('t1')).toBe('p1')
  })

  it('has no "No epic" when every task is in a story', async () => {
    serve(p1Routes([task('t1', 1)]))
    expect((await loadBoard(staff)).workspace.epics.map(e => e.id)).toEqual(['e1', 'e2'])
  })

  it('shows a legacy sprint under each epic its tasks are in, and a sprint of an epic once', async () => {
    serve(
      p1Routes(
        [task('t1', 1, { sprint_id: 's1' }), task('t2', 2, { story_id: 'e2', sprint_id: 's1' }), task('t3', 3, { sprint_id: 's2' })],
        [sprint('s1'), sprint('s2', { story_id: 'e1' })],
      ),
    )
    const { workspace, tasks } = await loadBoard(staff)
    expect(workspace.sprints.map(s => [s.id, s.epic])).toEqual([
      ['s1~e1', 'e1'],
      ['s1~e2', 'e2'],
      ['s2', 'e1'],
    ])
    expect(tasks.map(t => [t.id, t.sprint])).toEqual([
      ['t1', 's1~e1'],
      ['t2', 's1~e2'],
      ['t3', 's2'],
    ])
  })

  it('gives tasks their key, names and subtasks (as linked tasks and in the parent)', async () => {
    serve(p1Routes([task('t1', 7), task('c1', 8, { parent_task_id: 't1', title: 'Test flow', status: 'done' })]))
    const { tasks } = await loadBoard(staff)
    const parent = tasks.find(t => t.id === 't1')!
    expect(parent.subKey).toBe('AFSP-7')
    expect(parent.assignee).toBe('Chary')
    expect(parent.subs).toEqual([{ t: 'Test flow', done: true, sid: 'c1', due: '', assignee: 'Chary', note: '' }])
    expect(tasks.find(t => t.id === 'c1')).toMatchObject({ parent: 't1', subKey: 'AFSP-8' })
  })

  it('reads the whole board in one request (the backend scopes it to the person), and nothing staff-only', async () => {
    const cuser: Session = { personId: 'k1', name: 'Kari', email: 'k@x', role: 'cuser', org: 'Daco', orgId: 'c1' }
    serve(p1Routes([task('t1', 1)]))
    await loadBoard(cuser)
    expect(get.mock.calls.map(c => c[0])).toEqual(['/board'])
  })

  it('leaves archived projects out', async () => {
    serve({ '/projects?limit=100&page=1': [project('p9', 'OLD', { is_archived: true })] })
    expect(await loadBoard(staff)).toMatchObject({ workspace: { epics: [], sprints: [] }, tasks: [] })
  })

  it('is empty when nobody is signed in', async () => {
    expect((await loadBoard(null)).tasks).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})

describe('fetchWorkspace and fetchTasks', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('share one load when asked together', async () => {
    serve(p1Routes([task('t1', 1)]))
    const [ws, tasks] = await Promise.all([fetchWorkspace(staff), fetchTasks(staff)])
    expect(ws.epics.length).toBe(2)
    expect(tasks.length).toBe(1)
    const paths = get.mock.calls.map(c => c[0])
    expect(paths.length).toBe(new Set(paths).size)
  })

  it('load again on the next round', async () => {
    serve(p1Routes([task('t1', 1)]))
    await fetchWorkspace(staff)
    await fetchTasks(staff)
    expect(get.mock.calls.filter(c => c[0] === '/board').length).toBe(2)
  })
})
