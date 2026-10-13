import { describe, expect, it, vi } from 'vitest'

const { fetchCompanies, fetchInternalProjects } = vi.hoisted(() => ({
  fetchCompanies: vi.fn(async () => [{ id: 'c1' }]),
  fetchInternalProjects: vi.fn(async () => [{ id: 'i1' }]),
}))
vi.mock('./http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
vi.mock('./http/companies', () => ({ fetchCompanies, fetchInternalProjects, allPages: vi.fn() }))
vi.mock('./session/store', () => ({ readSession: () => ({ personId: 'a0', name: 'A', email: 'a@x', role: 'super', org: 'Viljetech' }) }))

const { server } = await import('./server')

describe('server.get in API mode', () => {
  it('reads companies and internal projects from the backend for the signed-in person', async () => {
    expect(await server.get('companies')).toEqual([{ id: 'c1' }])
    expect(await server.get('internalProjects')).toEqual([{ id: 'i1' }])
    expect(fetchCompanies).toHaveBeenCalledWith(expect.objectContaining({ personId: 'a0' }))
    expect(fetchInternalProjects).toHaveBeenCalledWith(expect.objectContaining({ personId: 'a0' }))
  })
})
