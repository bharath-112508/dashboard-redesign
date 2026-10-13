import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined })

const { readSession } = await import('./store')

describe('readSession', () => {
  beforeEach(() => store.clear())

  it('reads a session whose person id is a backend id string', () => {
    store.set('vt.session', JSON.stringify({ personId: '665f1c2e9b1d8a0012ab34cd', name: 'Asha', email: 'a@x', role: 'super', org: 'Viljetech' }))
    expect(readSession()?.personId).toBe('665f1c2e9b1d8a0012ab34cd')
  })

  it('treats a session saved with a numeric id (before version 5) as signed out', () => {
    store.set('vt.session', JSON.stringify({ personId: 3, name: 'Chary', email: 'c@x', role: 'dev', org: 'Viljetech' }))
    expect(readSession()).toBeNull()
  })
})
