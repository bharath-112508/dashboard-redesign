import { describe, expect, it, vi } from 'vitest'

const { fetchCompanies, fetchInternalProjects, sendCompanyCommand } = vi.hoisted(() => ({
  fetchCompanies: vi.fn(async () => [{ id: 'c1' }]),
  fetchInternalProjects: vi.fn(async () => [{ id: 'i1' }]),
  sendCompanyCommand: vi.fn(async (): Promise<{ id?: string }> => ({ id: 'c1' })),
}))
const { fetchWorkspace, fetchTasks } = vi.hoisted(() => ({
  fetchWorkspace: vi.fn(async () => ({ statuses: [], epics: [{ id: 'e1' }], sprints: [], devopsLinks: {} })),
  fetchTasks: vi.fn(async () => [{ id: 't1' }]),
}))
vi.mock('./http/board', () => ({ fetchWorkspace, fetchTasks }))
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
