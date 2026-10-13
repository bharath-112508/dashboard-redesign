import { describe, expect, it, vi } from 'vitest'
import type { Task } from './types'

const { fetchCompanies, fetchInternalProjects, sendCompanyCommand } = vi.hoisted(() => ({
  fetchCompanies: vi.fn(async () => [{ id: 'c1' }]),
  fetchInternalProjects: vi.fn(async () => [{ id: 'i1' }]),
  sendCompanyCommand: vi.fn(async (): Promise<{ id?: string }> => ({ id: 'c1' })),
}))
const { fetchWorkspace, fetchTasks, sendBoardCommand } = vi.hoisted(() => ({
  sendBoardCommand: vi.fn(async (): Promise<{ id?: string }> => ({ id: 'real1' })),
  fetchWorkspace: vi.fn(async () => ({ statuses: [], epics: [{ id: 'e1' }], sprints: [], devopsLinks: {} })),
  fetchTasks: vi.fn(async () => [{ id: 't1' }]),
}))
vi.mock('./http/board', () => ({
  fetchWorkspace,
  fetchTasks,
  sendBoardCommand,
  isBoardApiCommand: (c: { type: string }) => c.type.startsWith('task.'),
}))
const { fetchEntries, fetchWeekSubmissions, sendTimeCommand } = vi.hoisted(() => ({
  sendTimeCommand: vi.fn(async (): Promise<{ id?: string }> => ({ id: 'x9' })),
  fetchEntries: vi.fn(async () => [{ id: 'x1' }]),
  fetchWeekSubmissions: vi.fn(async () => [{ week: '2026-10-05' }]),
}))
vi.mock('./http/timesheet', () => ({ fetchEntries, fetchWeekSubmissions, isTimeApiCommand: (c: { type: string }) => c.type.startsWith('time.') || c.type.startsWith('week.'), sendTimeCommand }))
vi.mock('./http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
vi.mock('./http/companies', () => ({
  fetchCompanies,
  fetchInternalProjects,
  sendCompanyCommand,
  isCompanyApiCommand: (c: { type: string }) => c.type.startsWith('company.') || c.type.startsWith('project.'),
  allPages: vi.fn(),
}))
vi.mock('./session/store', () => ({ readSession: () => ({ personId: 'a0', name: 'A', email: 'a@x', role: 'super', org: 'Viljetech' }) }))

const { server, RefusedError } = await import('./server')
const { ApiError } = await import('./http/client')

describe('server.get in API mode', () => {
  it('reads companies and internal projects from the backend for the signed-in person', async () => {
    expect(await server.get('companies')).toEqual([{ id: 'c1' }])
    expect(await server.get('internalProjects')).toEqual([{ id: 'i1' }])
    expect(fetchCompanies).toHaveBeenCalledWith(expect.objectContaining({ personId: 'a0' }))
    expect(fetchInternalProjects).toHaveBeenCalledWith(expect.objectContaining({ personId: 'a0' }))
  })

  it('reads time entries and submitted weeks from the backend', async () => {
    expect(await server.get('entries')).toEqual([{ id: 'x1' }])
    expect(await server.get('weekSubmissions')).toEqual([{ week: '2026-10-05' }])
  })

  it('reads the workspace and tickets from the backend', async () => {
    expect((await server.get('workspace')).epics).toEqual([{ id: 'e1' }])
    expect(await server.get('tasks')).toEqual([{ id: 't1' }])
    expect(fetchTasks).toHaveBeenCalledWith(expect.objectContaining({ personId: 'a0' }))
  })
})

describe('server.send in API mode', () => {
  it('sends company and project commands to the backend and returns the backend id as apiId', async () => {
    const cmd = { type: 'company.archive', id: 'c1', archived: true, at: null } as const
    expect(await server.send(cmd)).toEqual({ apiId: 'c1' })
    expect(sendCompanyCommand).toHaveBeenCalledWith(cmd, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('turns a 403 from the backend into the refusal the pages already handle', async () => {
    sendCompanyCommand.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'You may not archive this company.'))
    await expect(server.send({ type: 'company.archive', id: 'c1', archived: true, at: null })).rejects.toBeInstanceOf(RefusedError)
  })

  it('passes other backend errors through unchanged', async () => {
    sendCompanyCommand.mockRejectedValueOnce(new ApiError(409, 'DUPLICATE_RESOURCE', 'Taken'))
    await expect(server.send({ type: 'company.archive', id: 'c1', archived: true, at: null })).rejects.toMatchObject({ status: 409 })
  })
})

describe('server.send for board commands in API mode', () => {
  const task = { id: '1', title: 'T', type: 'Task', status: 'todo', prio: 'Medium', due: '', assignee: '', contribs: [], est: '', desc: '', atts: [], subs: [], deps: [], epic: 'e1', sprint: null, start: '', time: {}, acts: [] } satisfies Task

  it("gives a new ticket's backend id back, so its window moves to the real ticket", async () => {
    expect(await server.send({ type: 'task.create', task })).toEqual({ id: 'real1', apiId: 'real1' })
  })

  it('turns a backend refusal into the refusal the board shows (the card snaps back)', async () => {
    sendBoardCommand.mockRejectedValueOnce(new ApiError(403, 'TASK_WRITE_FORBIDDEN', 'You may only update: status'))
    await expect(server.send({ type: 'task.update', id: 't1', patch: { status: 'done' } })).rejects.toBeInstanceOf(RefusedError)
  })
})

describe('backend validation answers', () => {
  it("are shown like refusals, with the backend's reason", async () => {
    sendBoardCommand.mockRejectedValueOnce(new ApiError(422, 'VALIDATION_ERROR', 'Status qa is not a status of this project'))
    const err = await server.send({ type: 'task.update', id: 't1', patch: { status: 'qa' } }).catch(e => e)
    expect(err).toBeInstanceOf(RefusedError)
    expect(err.message).toBe('Status qa is not a status of this project')
  })
})

describe('server.send for time in API mode', () => {
  it('sends time to the backend and gives back the new entry id', async () => {
    const entry = { id: '', date: '2026-10-12', userId: 'a0', user: 'A', type: 'General', task: null, notes: '', bill: 1, non: 0 }
    expect(await server.send({ type: 'time.log', entry })).toEqual({ apiId: 'x9' })
    expect(sendTimeCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'time.log' }), expect.objectContaining({ personId: 'a0' }))
  })

  it('shows a locked week as a refusal with its reason', async () => {
    sendTimeCommand.mockRejectedValueOnce(new ApiError(409, 'TIMESHEET_WEEK_SUBMITTED', 'This week is submitted. Reopen it to change its time.'))
    const err = await server.send({ type: 'time.remove', id: 'x1' }).catch(e => e)
    expect(err).toBeInstanceOf(RefusedError)
    expect(err.message).toBe('This week is submitted. Reopen it to change its time.')
  })
})
