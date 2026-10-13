import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get } }))

const { fetchCompanies, fetchInternalProjects } = await import('./companies')

const project = (id: string, company_id: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Project ${id}`,
  description: '',
  status: 'active',
  is_archived: false,
  start_date: '2026-09-01',
  end_date: null,
  member_ids: [],
  company_id,
  task_count: 0,
  done_task_count: 0,
  ...extra,
})

/** Answers each path from a table; unknown paths fail the test. */
const serve = (routes: Record<string, unknown[]>) =>
  get.mockImplementation(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected call ${path}`)
    return routes[path]
  })

const staff: Session = { personId: 'a0', name: 'Admin', email: 'a@x', role: 'super', org: 'Viljetech' }

describe('fetchCompanies', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('builds each company with its projects (and their epics) and its contacts', async () => {
    serve({
      '/companies?limit=100&page=1': [
        { id: 'c1', name: 'Aurora Foods AB', status: 'active' },
        { id: 'c2', name: 'Old Client', status: 'archived', archived_at: '2026-09-01T00:00:00Z' },
      ],
      '/projects?limit=100&page=1': [project('p1', 'c1'), project('p2', 'c1', { is_archived: true }), project('i1', null)],
      '/projects/p1/stories?limit=100&page=1': [{ id: 's1', title: 'Web app', derived_status: 'in_progress', progress_percent: 50, sprint_ids: ['x'] }],
      '/companies/c1/representatives?limit=100&page=1': [
        { id: 'u7', full_name: 'Emma', email: 'e@x', role: 'client', status: 'active', title: 'CEO', projects: [{ id: 'p1', name: 'P', code: 'P' }] },
      ],
      '/companies/c2/representatives?limit=100&page=1': [],
    })

    const companies = await fetchCompanies(staff)

    expect(companies.map(c => [c.id, c.archived])).toEqual([
      ['c1', false],
      ['c2', true],
    ])
    const aurora = companies[0]
    // Archived projects and internal projects are not client projects of the company.
    expect(aurora.projects.map(p => p.id)).toEqual(['p1'])
    expect(aurora.projects[0].epics).toEqual([{ id: 's1', name: 'Web app', state: 'active', pct: 50, sprints: 1 }])
    expect(aurora.contacts).toEqual([{ personId: 'u7', name: 'Emma', role: 'CEO', email: 'e@x', projects: ['p1'], admin: true }])
  })

  it('reads every page of a long list', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, status: 'active' }))
    const routes: Record<string, unknown[]> = {
      '/companies?limit=100&page=1': page1,
      '/companies?limit=100&page=2': [{ id: 'last', name: 'Last', status: 'active' }],
      '/projects?limit=100&page=1': [],
    }
    for (const c of [...page1, { id: 'last' }]) routes[`/companies/${c.id}/representatives?limit=100&page=1`] = []
    serve(routes)

    expect(await fetchCompanies(staff)).toHaveLength(101)
  })

  it("lists a client admin's contacts only for their own company", async () => {
    serve({
      '/companies?limit=100&page=1': [{ id: 'c1', name: 'Aurora Foods AB', status: 'active' }],
      '/projects?limit=100&page=1': [],
      '/companies/c1/representatives?limit=100&page=1': [],
    })

    await fetchCompanies({ personId: 'u7', name: 'Emma', email: 'e@x', role: 'cadmin', org: 'Aurora Foods AB', orgId: 'c1' })

    expect(get.mock.calls.map(c => c[0])).not.toContain('/companies/c2/representatives?limit=100&page=1')
  })

  it('gives a client user their company from the session, since they may not read companies', async () => {
    serve({ '/projects?limit=100&page=1': [project('p1', 'c1')], '/projects/p1/stories?limit=100&page=1': [] })

    const companies = await fetchCompanies({ personId: 'u8', name: 'Lars', email: 'l@x', role: 'cuser', org: 'Aurora Foods AB', orgId: 'c1' })

    expect(get.mock.calls.map(c => c[0])).toEqual(['/projects?limit=100&page=1', '/projects/p1/stories?limit=100&page=1'])
    expect(companies).toHaveLength(1)
    expect(companies[0]).toMatchObject({ id: 'c1', name: 'Aurora Foods AB', contacts: [], archived: false })
    expect(companies[0].projects.map(p => p.id)).toEqual(['p1'])
  })

  it('returns nothing when nobody is signed in', async () => {
    expect(await fetchCompanies(null)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})

describe('fetchInternalProjects', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('returns the projects without a company, leaving out archived ones', async () => {
    serve({ '/projects?limit=100&page=1': [project('p1', 'c1'), project('i1', null, { area: 'Ops' }), project('i2', null, { is_archived: true })] })

    const internal = await fetchInternalProjects(staff)

    expect(internal.map(p => [p.id, p.area])).toEqual([['i1', 'Ops']])
  })

  it('gives client users no internal projects, without calling the API', async () => {
    expect(await fetchInternalProjects({ personId: 'u8', name: 'L', email: 'l@x', role: 'cuser', org: 'A', orgId: 'c1' })).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})
