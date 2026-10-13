import { describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn(async () => [{ id: 'p1' }]) }))
vi.mock('../server', () => ({ server: { get } }))

const { fetchPeople } = await import('./directory')

describe('fetchPeople', () => {
  it('reads the people resource (the server picks mock or backend; see http/users.ts)', async () => {
    expect(await fetchPeople(null)).toEqual([{ id: 'p1' }])
    expect(get).toHaveBeenCalledWith('people')
  })
})
