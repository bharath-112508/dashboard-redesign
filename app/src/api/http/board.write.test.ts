import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Task } from '../types'

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('./client', async importOriginal => ({
  ...(await importOriginal<typeof import('./client')>()),
  api: { get, post, patch, delete: del },
}))

const { loadBoard, sendBoardCommand, isBoardApiCommand, fetchTasks, ticketAlias, attachFile } = await import('./board')
const { ApiError } = await import('./client')
const cuser: Session = { personId: 'k1', name: 'Kari', email: 'k@x', role: 'cuser', org: 'Aurora', orgId: 'c1' }

const staff: Session = { personId: 'a0', name: 'Admin', email: 'a@x', role: 'super', org: 'Viljetech' }
const TODAY = '2026-10-13'

const bt = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
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
  assignee_ids: [],
  primary_assignee_id: null,
  collaborator_ids: [],
  source: null,
  depends_on_task_ids: [],
  created_at: '2026-10-07T09:00:00.000Z',
  ...extra,
})

const ROUTES: Record<string, unknown> = {
  '/projects?limit=100&page=1': [{ id: 'p1', code: 'AFSP', name: 'P1', status: 'active', is_archived: false, start_date: '2026-09-01', end_date: null, member_ids: [], company_id: 'c1' }],
  '/projects/p1/stories?limit=100&page=1': [{ id: 'e1', project_id: 'p1', title: 'Web app' }, { id: 'e2', project_id: 'p1', title: 'Mobile' }],
  '/projects/p1/sprints?limit=100&page=1': [
    { id: 's1', project_id: 'p1', name: 'Sprint 1', start_date: '2026-10-05', end_date: '2026-10-16', status: 'active', story_id: null, member_ids: ['u1', 'x9'] },
  ],
  '/projects/p1/custom-statuses': { defaults: [], custom: [] },
  '/projects/p1/members': [
    { id: 'u1', full_name: 'Chary' },
    { id: 'u2', full_name: 'Rahul' },
  ],
  '/tasks?project_id=p1&limit=100&page=1': [
    bt('t1', 1, { sprint_id: 's1', depends_on_task_ids: ['t9'], collaborator_ids: ['u2', 'x9'] }),
    bt('t2', 2, { story_id: 'e2', sprint_id: 's1' }),
    bt('t3', 3, { story_id: null }),
    bt('c1', 4, { parent_task_id: 't1', title: 'Test flow' }),
    bt('c2', 5, { parent_task_id: 't1', title: 'Error states', status: 'done' }),
  ],
}

const newTask = (over: Partial<Task> = {}): Task => ({
  id: '1',
  title: 'Fix login',
  type: 'Bug',
  status: 'todo',
  prio: 'High',
  due: '',
  assignee: 'Chary',
  assignees: ['Chary'],
  contribs: [],
  est: '',
  desc: '',
  atts: [],
  subs: [],
  deps: [],
  epic: 'e1',
  sprint: 's1~e1',
  start: '2026-10-13',
  time: {},
  acts: [],
  ...over,
})

beforeEach(async () => {
  for (const m of [get, post, patch, del]) m.mockReset()
  get.mockImplementation(async (path: string) => {
    if (!(path in ROUTES)) throw new Error(`unexpected call ${path}`)
    return ROUTES[path]
  })
  post.mockResolvedValue({ id: 'new1' })
  patch.mockResolvedValue({})
  del.mockResolvedValue(undefined)
  await loadBoard(staff)
})

describe('isBoardApiCommand', () => {
  it('takes ticket, epic and sprint commands, and batches made only of them', () => {
    expect(isBoardApiCommand({ type: 'task.update' })).toBe(true)
    expect(isBoardApiCommand({ type: 'tickets.task.createTop' })).toBe(true)
    expect(isBoardApiCommand({ type: 'question.create' })).toBe(false)
    expect(isBoardApiCommand({ type: 'batch', cmds: [{ type: 'task.create' }, { type: 'task.update' }] } as never)).toBe(true)
    expect(isBoardApiCommand({ type: 'batch', cmds: [{ type: 'task.update' }, { type: 'question.create' }] } as never)).toBe(false)
    expect(isBoardApiCommand({ type: 'batch', cmds: [] } as never)).toBe(false)
  })
})

describe('tickets', () => {
  it('creates a ticket in its epic\'s project and returns the backend id', async () => {
    expect(await sendBoardCommand({ type: 'task.create', task: newTask() }, TODAY)).toEqual({ id: 'new1' })
    expect(post).toHaveBeenCalledWith('/tasks', {
      project_id: 'p1',
      title: 'Fix login',
      issue_type: 'bug',
      status: 'to_do',
      priority: 'high',
      due_date: null,
      start_date: '2026-10-13',
      estimated_hours: 0,
      description: '',
      assignee_ids: ['u1'],
      collaborator_ids: [],
      story_id: 'e1',
      sprint_id: 's1',
    })
  })

  it('keeps a new ticket without a title as a draft on the board, and drops it if left empty', async () => {
    expect(await sendBoardCommand({ type: 'task.create', task: newTask({ id: '5', title: '', isNew: true }) }, TODAY)).toEqual({})
    expect(post).not.toHaveBeenCalled()
    expect((await fetchTasks(staff)).find(t => t.id === '5')).toMatchObject({ isNew: true, title: '' })
    await sendBoardCommand({ type: 'task.delete', id: '5' }, TODAY)
    expect(del).not.toHaveBeenCalled()
    expect((await fetchTasks(staff)).some(t => t.id === '5')).toBe(false)
  })

  it('creates the draft once it gets a title, with what was set on it, and remembers its real id', async () => {
    await sendBoardCommand({ type: 'tickets.task.createTop', task: newTask({ id: '6', title: '', isNew: true }) }, TODAY)
    await sendBoardCommand({ type: 'task.update', id: '6', patch: { prio: 'Critical' } }, TODAY)
    expect(post).not.toHaveBeenCalled()
    await sendBoardCommand({ type: 'task.update', id: '6', patch: { title: 'Named', isNew: false } }, TODAY)
    expect(post).toHaveBeenNthCalledWith(1, '/tasks', expect.objectContaining({ title: 'Named', priority: 'critical' }))
    expect(post).toHaveBeenNthCalledWith(2, '/tasks/new1/rank', {})
    expect(ticketAlias('6')).toBe('new1')
    expect((await fetchTasks(staff)).some(t => t.id === '6')).toBe(false)
  })

  it('creates a ticket in "No epic" with no story', async () => {
    await sendBoardCommand({ type: 'task.create', task: newTask({ epic: 'none~p1', sprint: null }) }, TODAY)
    expect(post.mock.calls[0][1]).toMatchObject({ project_id: 'p1', story_id: null, sprint_id: null })
  })

  it('puts a ticket made with the column "+" at the top', async () => {
    await sendBoardCommand({ type: 'tickets.task.createTop', task: newTask() }, TODAY)
    expect(post).toHaveBeenNthCalledWith(2, '/tasks/new1/rank', {})
  })

  it('creates a subtask record under its parent', async () => {
    await sendBoardCommand({ type: 'task.create', task: newTask({ parent: 't1' }) }, TODAY)
    expect(post.mock.calls[0][1]).toMatchObject({ parent_task_id: 't1' })
  })

  it('updates only the fields changed', async () => {
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { status: 'prog' }, log: 'moved it' }, TODAY)
    expect(patch).toHaveBeenCalledWith('/tasks/t1', { status: 'in_progress' })
  })

  it('moves a ticket to a legacy sprint and another epic by their real ids', async () => {
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { epic: 'e2', sprint: 's1~e2' } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/tasks/t1', { story_id: 'e2', sprint_id: 's1' })
  })

  it('saves subtask lines as linked tasks: new ones created, changed ones patched, removed ones deleted', async () => {
    const subs = [
      { t: 'Test flow (renamed)', done: true, sid: 'c1', due: '', assignee: '', note: '' },
      { t: 'Write docs', done: false },
    ]
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { subs } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/tasks/c1', { title: 'Test flow (renamed)', status: 'done' })
    expect(post).toHaveBeenCalledWith('/tasks', { project_id: 'p1', parent_task_id: 't1', title: 'Write docs', status: 'to_do' })
    expect(del).toHaveBeenCalledWith('/tasks/c2')
    expect(patch).not.toHaveBeenCalledWith('/tasks/t1', expect.anything())
  })

  it('links and unlinks blockers through the dependency routes', async () => {
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { deps: ['t2'] } }, TODAY)
    expect(post).toHaveBeenCalledWith('/tasks/t1/dependencies', { depends_on_task_id: 't2' })
    expect(del).toHaveBeenCalledWith('/tasks/t1/dependencies/t9')
  })

  it('sends an edit made right after creating a ticket to the new ticket', async () => {
    let finish: (v: { id: string }) => void = () => {}
    post.mockReturnValueOnce(new Promise(r => (finish = r)))
    const creating = sendBoardCommand({ type: 'task.create', task: newTask({ id: '7' }) }, TODAY)
    const editing = sendBoardCommand({ type: 'task.update', id: '7', patch: { title: 'Typed' } }, TODAY)
    finish({ id: 'real7' })
    await Promise.all([creating, editing])
    expect(patch).toHaveBeenCalledWith('/tasks/real7', { title: 'Typed' })
  })

  it('deletes a ticket', async () => {
    await sendBoardCommand({ type: 'task.delete', id: 't3' }, TODAY)
    expect(del).toHaveBeenCalledWith('/tasks/t3')
  })

  it('posts a comment', async () => {
    await sendBoardCommand({ type: 'task.comment', id: 't1', text: 'Looks good' }, TODAY)
    expect(post).toHaveBeenCalledWith('/tasks/t1/comments', { body: 'Looks good' })
  })

  it('passes a backend refusal on', async () => {
    patch.mockRejectedValueOnce(new ApiError(403, 'TASK_WRITE_FORBIDDEN', 'You may only update: status'))
    await expect(sendBoardCommand({ type: 'task.update', id: 't2', patch: { status: 'done' } }, TODAY)).rejects.toMatchObject({ status: 403 })
  })
})

describe('sprints', () => {
  it('creates a sprint in its epic\'s project', async () => {
    post.mockResolvedValueOnce({ id: 's9' })
    const sprint = { id: 'tmp', epic: 'e1', name: 'Sprint 2', start: '2026-10-19', end: '2026-10-30', members: ['Chary'], state: 'planned' as const, goal: 'G', goals: ['A'] }
    expect(await sendBoardCommand({ type: 'sprint.create', sprint }, TODAY)).toEqual({ id: 's9' })
    expect(post).toHaveBeenCalledWith('/projects/p1/sprints', {
      name: 'Sprint 2',
      start_date: '2026-10-19',
      end_date: '2026-10-30',
      goal: 'G',
      story_id: 'e1',
      member_ids: ['u1'],
      goals: ['A'],
    })
  })

  it('creates a "No epic" sprint without a story', async () => {
    const sprint = { id: 'tmp', epic: 'none~p1', name: 'S', start: '2026-10-19', end: '2026-10-30', members: [], state: 'planned' as const }
    await sendBoardCommand({ type: 'sprint.create', sprint }, TODAY)
    expect(post.mock.calls[0][1]).not.toHaveProperty('story_id')
  })

  it('updates the one real sprint behind a legacy entry', async () => {
    await sendBoardCommand({ type: 'sprint.update', id: 's1~e2', patch: { name: 'Renamed', goalsDone: { 0: true, 1: false, 2: true } } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/sprints/s1', { name: 'Renamed', goals_done: [0, 2] })
  })

  it('starts and completes sprints through their routes', async () => {
    await sendBoardCommand({ type: 'sprint.update', id: 's1~e1', patch: { state: 'active' } }, TODAY)
    expect(post).toHaveBeenCalledWith('/sprints/s1/start', {})
    await sendBoardCommand({ type: 'sprint.update', id: 's1~e1', patch: { state: 'done', summary: 'Completed' } }, TODAY)
    expect(post).toHaveBeenCalledWith('/sprints/s1/complete', { move_unfinished_to: 'backlog' })
    expect(patch).toHaveBeenCalledWith('/sprints/s1', { summary: 'Completed' })
  })

  it('adds members to the ones it has', async () => {
    await sendBoardCommand({ type: 'sprint.addMembers', id: 's1~e1', names: ['Rahul', 'Chary'] }, TODAY)
    expect(patch).toHaveBeenCalledWith('/sprints/s1', { member_ids: ['u1', 'x9', 'u2'] })
  })
})

describe('epics', () => {
  it('creates an epic in the given project with its document', async () => {
    post.mockResolvedValueOnce({ id: 'e9' })
    const epic = { id: 'tmp', name: 'Admin portal', p: 0, desc: 'Short', goal: '', story: 'As an admin…', criteria: ['Fast'], target: '' }
    expect(await sendBoardCommand({ type: 'epic.create', epic, projectId: 'p1' }, TODAY)).toEqual({ id: 'e9' })
    expect(post).toHaveBeenCalledWith('/projects/p1/stories', {
      title: 'Admin portal',
      description: 'Short',
      goal: '',
      user_story: 'As an admin…',
      criteria: ['Fast'],
      target_date: null,
    })
  })

  it('creates an epic in the first project when none is given', async () => {
    await sendBoardCommand({ type: 'epic.create', epic: { id: 'tmp', name: 'X', p: 0 } }, TODAY)
    expect(post.mock.calls[0][0]).toBe('/projects/p1/stories')
  })

  it('updates an epic\'s document', async () => {
    await sendBoardCommand({ type: 'epic.update', id: 'e1', patch: { inScope: ['Login'], critDone: { 1: true }, questions: ['?'] } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/stories/e1', { in_scope: ['Login'], criteria_done: [1], open_questions: ['?'] })
  })

  it('refuses editing "No epic"', async () => {
    await expect(sendBoardCommand({ type: 'epic.update', id: 'none~p1', patch: { name: 'X' } }, TODAY)).rejects.toMatchObject({ status: 403 })
    expect(patch).not.toHaveBeenCalled()
  })
})

describe('batch', () => {
  it('runs each command in order', async () => {
    await sendBoardCommand(
      {
        type: 'batch',
        cmds: [
          { type: 'task.update', id: 't1', patch: { sprint: null } },
          { type: 'task.update', id: 't2', patch: { sprint: null } },
        ],
      },
      TODAY,
    )
    expect(patch.mock.calls.map(c => c[0])).toEqual(['/tasks/t1', '/tasks/t2'])
  })
})

describe('review fixes', () => {
  it('sends a client\'s bug report to the report route, without ranking it', async () => {
    await sendBoardCommand(
      { type: 'task.create', top: true, task: newTask({ prio: 'Critical', desc: 'It breaks', clientBug: { reported: 'today', chat: [] } }) },
      TODAY,
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/tasks/report', { project_id: 'p1', kind: 'issue', title: 'Fix login', description: 'It breaks', priority: 'high' })
  })

  it('keeps a new ticket when only putting it at the top is refused', async () => {
    post.mockResolvedValueOnce({ id: 'new1' }).mockRejectedValueOnce(new ApiError(403, 'TASK_WRITE_FORBIDDEN', 'no'))
    expect(await sendBoardCommand({ type: 'tickets.task.createTop', task: newTask() }, TODAY)).toEqual({ id: 'new1' })
  })

  it('refuses a person who is not on the project instead of clearing the field', async () => {
    await expect(sendBoardCommand({ type: 'task.update', id: 't1', patch: { assignee: 'Ghost' } }, TODAY)).rejects.toMatchObject({ status: 403 })
    expect(patch).not.toHaveBeenCalled()
  })

  it('keeps contributors the board cannot name when contributors change', async () => {
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { contribs: ['Chary'] } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/tasks/t1', { collaborator_ids: ['u1', 'x9'] })
  })

  it('does not create a subtask line twice when the next edit comes before the reload', async () => {
    post.mockResolvedValueOnce({ id: 'c3' })
    const was = [
      { t: 'Test flow', done: false, sid: 'c1', due: '', assignee: '', note: '' },
      { t: 'Error states', done: true, sid: 'c2', due: '', assignee: '', note: '' },
    ]
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { subs: [...was, { t: 'A', done: false }] } }, TODAY)
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { subs: [{ ...was[0], done: true }, was[1], { t: 'A', done: false }] } }, TODAY)
    expect(post.mock.calls.filter(c => c[0] === '/tasks')).toHaveLength(1)
    expect(del).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledWith('/tasks/c1', { status: 'done' })
  })

  it('sends one write at a time, in order', async () => {
    let release: () => void = () => {}
    patch.mockReturnValueOnce(new Promise<void>(r => (release = r)))
    const first = sendBoardCommand({ type: 'task.update', id: 't1', patch: { title: 'A' } }, TODAY)
    const second = sendBoardCommand({ type: 'task.update', id: 't2', patch: { title: 'B' } }, TODAY)
    await new Promise(r => setTimeout(r, 0))
    expect(patch).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(patch.mock.calls.map(c => c[0])).toEqual(['/tasks/t1', '/tasks/t2'])
  })

  it('gives a subtask of a ticket made since the last load its project', async () => {
    post.mockResolvedValueOnce({ id: 'n5' }).mockResolvedValueOnce({ id: 'c9' })
    await sendBoardCommand({ type: 'task.create', task: newTask({ id: '5' }) }, TODAY)
    await sendBoardCommand({ type: 'task.update', id: 'n5', patch: { subs: [{ t: 'Sub', done: false }] } }, TODAY)
    expect(post).toHaveBeenLastCalledWith('/tasks', { project_id: 'p1', parent_task_id: 'n5', title: 'Sub', status: 'to_do' })
  })

  it('changes blockers before the ticket, so a refused blocker change saves nothing', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'TASK_WRITE_FORBIDDEN', 'no'))
    await expect(sendBoardCommand({ type: 'task.update', id: 't1', patch: { title: 'X', deps: ['t9', 't2'] } }, TODAY)).rejects.toMatchObject({ status: 403 })
    expect(patch).not.toHaveBeenCalled()
  })

  it('does not hand one person\'s board or drafts to the next person', async () => {
    await sendBoardCommand({ type: 'task.create', task: newTask({ id: '8', title: '', isNew: true }) }, TODAY)
    expect((await fetchTasks(cuser)).some(t => t.id === '8')).toBe(false)
    expect(await fetchTasks(null)).toEqual([])
  })
})

describe('attachments', () => {
  const file = new File(['hello world'], 'spec.pdf', { type: 'application/pdf' })
  const put = vi.fn()
  beforeEach(() => {
    put.mockReset()
    put.mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', put)
  })

  it('uploads a new file: signed URL, the upload itself, then finalize', async () => {
    post.mockImplementation(async (path: string) =>
      path.endsWith('/upload-url')
        ? { upload_url: 'https://blob.example/c/key?sig', blob_container: 'c', blob_key: 'tasks/t1/key', required_headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/pdf' } }
        : { id: 'f9' },
    )
    const ref = attachFile(file)
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { atts: [{ id: 'f1', name: 'old.png', size: '1 KB', date: 'x' }, { name: 'spec.pdf', size: '1 KB', date: 'x', fileRef: ref }] } }, TODAY)
    expect(post).toHaveBeenNthCalledWith(1, '/tasks/t1/attachments/upload-url', { file_name: 'spec.pdf', file_size: 11, mime_type: 'application/pdf' })
    expect(put).toHaveBeenCalledWith('https://blob.example/c/key?sig', {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/pdf' },
      body: file,
    })
    expect(post).toHaveBeenNthCalledWith(2, '/tasks/t1/attachments/finalize', {
      blob_container: 'c',
      blob_key: 'tasks/t1/key',
      file_name: 'spec.pdf',
      file_size: 11,
      mime_type: 'application/pdf',
    })
    expect(patch).not.toHaveBeenCalled()
  })

  it('stops before uploading when the backend refuses', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'TASK_WRITE_FORBIDDEN', 'no'))
    const ref = attachFile(file)
    await expect(sendBoardCommand({ type: 'task.update', id: 't1', patch: { atts: [{ name: 'spec.pdf', size: '1 KB', date: 'x', fileRef: ref }] } }, TODAY)).rejects.toMatchObject({ status: 403 })
    expect(put).not.toHaveBeenCalled()
  })

  it('reports a failed upload and does not finalize it', async () => {
    post.mockResolvedValueOnce({ upload_url: 'https://blob.example/u', blob_container: 'c', blob_key: 'k', required_headers: {} })
    put.mockResolvedValueOnce(new Response(null, { status: 403 }))
    const ref = attachFile(file)
    await expect(sendBoardCommand({ type: 'task.update', id: 't1', patch: { atts: [{ name: 'spec.pdf', size: '1 KB', date: 'x', fileRef: ref }] } }, TODAY)).rejects.toMatchObject({ status: 403, message: 'The file could not be uploaded. Try again.' })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does nothing for attachments that are already saved', async () => {
    await sendBoardCommand({ type: 'task.update', id: 't1', patch: { atts: [{ id: 'f1', name: 'old.png', size: '1 KB', date: 'x' }] } }, TODAY)
    expect(post).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })
})
