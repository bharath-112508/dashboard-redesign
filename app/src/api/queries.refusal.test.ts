import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.mock('./http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
vi.mock('./session/store', () => ({ readSession: () => ({ personId: 'u8', name: 'Lars', email: 'l@x', role: 'cuser', org: 'Daco', orgId: 'c1' }) }))
const { refusal } = vi.hoisted(() => ({ refusal: vi.fn() }))
vi.mock('./session/permissions', () => ({ refusal }))
vi.mock('./http/companies', async importOriginal => ({ ...(await importOriginal<typeof import('./http/companies')>()) }))

const { refuseBeforeSending } = await import('./queries')
const { RefusedError } = await import('./server')

describe('refuseBeforeSending (API mode)', () => {
  it("refuses a command the signed-in role may not run, with the same reason the mock gives, before it reaches the backend", () => {
    const qc = new QueryClient()
    qc.setQueryData(['tasks'], [])
    refusal.mockReturnValueOnce('A client user cannot delete a ticket.')
    expect(() => refuseBeforeSending(qc, { type: 'task.delete', id: 1 })).toThrow(RefusedError)
  })

  it('leaves company and project commands to the backend, which knows what each client may do there', () => {
    const qc = new QueryClient()
    qc.setQueryData(['companies'], [])
    refusal.mockReturnValue('do that')
    expect(() => refuseBeforeSending(qc, { type: 'company.update', id: 'c1', patch: { notes: 'x' } })).not.toThrow()
    refusal.mockReset()
  })

  it('lets an allowed command through', () => {
    const qc = new QueryClient()
    qc.setQueryData(['companies'], [])
    refusal.mockReturnValueOnce(null)
    expect(() => refuseBeforeSending(qc, { type: 'company.archive', id: 'c1', archived: true, at: null })).not.toThrow()
  })
})
