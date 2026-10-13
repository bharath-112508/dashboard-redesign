import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
vi.mock('../http/client', () => ({ api: { get } }))
vi.mock('../server', () => ({ server: { get: vi.fn() } }))

const { fetchPeople } = await import('./directory')

const user = (id: string, role = 'employee') => ({
  id,
  full_name: `Name ${id}`,
  email: `${id}@x`,
  role,
  status: 'active',
  timezone: 'UTC',
  last_login_at: null,
})

const admin: Session = { personId: 'a0', name: 'Admin', email: 'a0@x', role: 'super', org: 'Viljetech' }

describe('fetchPeople in API mode', () => {
  beforeEach(() => get.mockReset())

  it('reads every page of /users until a short page', async () => {
    get.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => user(`a${i}`)))
    get.mockResolvedValueOnce([user('b1')])
    const people = await fetchPeople(admin)
    expect(people).toHaveLength(101)
    expect(get).toHaveBeenNthCalledWith(1, '/users?limit=100&page=1')
    expect(get).toHaveBeenNthCalledWith(2, '/users?limit=100&page=2')
    expect(people[100]).toMatchObject({ id: 'b1', name: 'Name b1', role: 'dev' })
  })

  it('gives a client user only themselves, without calling /users (clients may not list users)', async () => {
    const people = await fetchPeople({ personId: 'c1', name: 'Lars', email: 'l@daco.no', role: 'cuser', org: 'Daco', orgId: 'co1' })
    expect(get).not.toHaveBeenCalled()
    expect(people).toEqual([expect.objectContaining({ id: 'c1', name: 'Lars', email: 'l@daco.no', role: 'cuser', org: 'co1', active: true })])
  })

  it('returns nobody when no one is signed in', async () => {
    expect(await fetchPeople(null)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})
