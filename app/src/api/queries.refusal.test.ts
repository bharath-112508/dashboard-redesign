import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.mock('./http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
vi.mock('./session/store', () => ({ readSession: () => ({ personId: 'u8', name: 'Lars', email: 'l@x', role: 'cuser', org: 'Daco', orgId: 'c1' }) }))
const { refusal } = vi.hoisted(() => ({ refusal: vi.fn() }))
vi.mock('./session/permissions', () => ({ refusal }))

const { refuseBeforeSending } = await import('./queries')
const { RefusedError } = await import('./server')

describe('refuseBeforeSending (API mode)', () => {
  it("refuses a command the signed-in role may not run, with the same reason the mock gives, before it reaches the backend", () => {
    const qc = new QueryClient()
    qc.setQueryData(['companies'], [])
    refusal.mockReturnValueOnce('A client user cannot archive a company.')
    expect(() => refuseBeforeSending(qc, { type: 'company.archive', id: 'c1', archived: true, at: null })).toThrow(RefusedError)
  })

  it('lets an allowed command through', () => {
    const qc = new QueryClient()
    qc.setQueryData(['companies'], [])
    refusal.mockReturnValueOnce(null)
    expect(() => refuseBeforeSending(qc, { type: 'company.archive', id: 'c1', archived: true, at: null })).not.toThrow()
  })
})
