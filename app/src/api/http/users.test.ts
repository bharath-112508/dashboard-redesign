import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get, liveProjects } = vi.hoisted(() => ({ get: vi.fn(), liveProjects: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get } }))
vi.mock('./companies', async importOriginal => ({ ...(await importOriginal<typeof import('./companies')>()), liveProjects }))

const { fetchPeopleApi, fetchAccessApi } = await import('./users')
const { DEFAULT_PERMS, DEFAULT_DEV_TYPES } = await import('../users/access')

const admin: Session = { personId: 'a0', name: 'Vilje Admin', email: 'a@x', role: 'super', org: 'Viljetech' }
const dev: Session = { ...admin, personId: 'u1', name: 'Rahul', role: 'dev' }
const cadmin: Session = { personId: 'k1', name: 'Emma', email: 'e@x', role: 'cadmin', org: 'Aurora', orgId: 'c1' }
const cuser: Session = { ...cadmin, personId: 'k2', name: 'Johan', role: 'cuser' }

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  full_name: `User ${id}`,
  email: `${id}@x`,
  role: 'employee',
  role_keys: ['employee'],
  status: 'active',
  timezone: 'Europe/Oslo',
  last_login_at: null,
  ...extra,
})

beforeEach(() => {
  get.mockReset()
  liveProjects.mockReset()
  liveProjects.mockResolvedValue([
    { id: 'p1', member_ids: ['u1', 'u2'] },
    { id: 'p2', member_ids: ['u2'] },
  ])
})

describe('fetchPeopleApi', () => {
  it('lists staff with their developer type, DevOps role, photo, status and projects', async () => {
    get.mockResolvedValueOnce([
      user('a0', { role: 'admin', role_keys: ['admin'] }),
      user('u1', { internal_profile: { dev_type: 'Backend' }, profile_photo_url: 'https://x/p.jpg' }),
      user('u2', { role_keys: ['employee', 'devops'], status: 'deactivated' }),
    ])
    const people = await fetchPeopleApi(admin)
    expect(get).toHaveBeenCalledWith('/users?show_deleted=true&limit=100&page=1')
    expect(people.map(p => [p.id, p.role, p.devType, p.photo, p.active, p.projects])).toEqual([
      ['a0', 'super', undefined, '', true, 'all'],
      ['u1', 'dev', 'Backend', 'https://x/p.jpg', true, ['p1']],
      ['u2', 'devops', undefined, '', false, ['p1', 'p2']],
    ])
  })

  it('does not ask for deactivated people as a developer (the backend would drop it anyway)', async () => {
    get.mockResolvedValueOnce([user('u1')])
    await fetchPeopleApi(dev)
    expect(get).toHaveBeenCalledWith('/users?limit=100&page=1')
  })

  it('gives a client admin themselves and their company\'s contacts, without listing users', async () => {
    get.mockResolvedValueOnce([
      { id: 'k1', full_name: 'Emma', email: 'e@x', role: 'client', status: 'active', timezone: 'UTC', last_login_at: null },
      { id: 'k2', full_name: 'Johan', email: 'j@x', role: 'representative', status: 'active', timezone: 'UTC', last_login_at: null },
    ])
    const people = await fetchPeopleApi(cadmin)
    expect(get.mock.calls.map(c => c[0])).toEqual(['/companies/c1/representatives?limit=100&page=1'])
    expect(people.map(p => [p.id, p.role, p.org])).toEqual([
      ['k1', 'cadmin', 'c1'],
      ['k2', 'cuser', 'c1'],
    ])
  })

  it('returns nobody when no one is signed in', async () => {
    expect(await fetchPeopleApi(null)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('reads every page of users', async () => {
    get.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => user(`a${i}`))).mockResolvedValueOnce([user('b1')])
    expect(await fetchPeopleApi(dev)).toHaveLength(101)
    expect(get).toHaveBeenNthCalledWith(2, '/users?limit=100&page=2')
  })

  it('gives a client user only themselves', async () => {
    const people = await fetchPeopleApi(cuser)
    expect(get).not.toHaveBeenCalled()
    expect(people.map(p => [p.id, p.name, p.role])).toEqual([['k2', 'Johan', 'cuser']])
  })
})

describe('fetchAccessApi', () => {
  it('uses the design\'s defaults until the grid is saved', async () => {
    get.mockResolvedValueOnce({ perms: null, dev_types: null })
    expect(await fetchAccessApi()).toEqual({ perms: DEFAULT_PERMS, devTypes: DEFAULT_DEV_TYPES })
  })

  it('uses what was saved, role by role', async () => {
    get.mockResolvedValueOnce({ perms: { dev: ['tk.edit'] }, dev_types: ['Backend'] })
    const a = await fetchAccessApi()
    expect(a.perms.dev).toEqual(['tk.edit'])
    expect(a.perms.pm).toEqual(DEFAULT_PERMS.pm)
    expect(a.devTypes).toEqual(['Backend'])
  })
})
