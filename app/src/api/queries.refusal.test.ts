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
    qc.setQueryData(['clientTeam'], [])
    refusal.mockReturnValueOnce('Clients cannot change that team.')
    expect(() => refuseBeforeSending(qc, { type: 'clientTeam.remove', id: 'm1' })).toThrow(RefusedError)
  })

  it('leaves DevOps, question and request commands to the backend, which scopes clients to their company', () => {
    const qc = new QueryClient()
    qc.setQueryData(['questions'], [])
    refusal.mockReturnValue('do that')
    expect(() => refuseBeforeSending(qc, { type: 'tickets.question.seen', id: 1, seen: 2 })).not.toThrow()
    expect(() => refuseBeforeSending(qc, { type: 'request.comment', id: 1, comment: { by: 'x', text: 'y', when: '', side: 'tickets' } })).not.toThrow()
    refusal.mockReset()
  })

  it('leaves ticket, epic and sprint commands to the backend', () => {
    const qc = new QueryClient()
    qc.setQueryData(['tasks'], [])
    refusal.mockReturnValue('do that')
    expect(() => refuseBeforeSending(qc, { type: 'task.delete', id: '1' })).not.toThrow()
    refusal.mockReset()
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

describe('writeErrorMessage', () => {
  it("shows a refusal's reason, and a plain message for anything else", async () => {
    const { writeErrorMessage } = await import('./queries')
    const { ApiError } = await import('./http/client')
    expect(writeErrorMessage(new RefusedError('Only DevOps and admins change DevOps items.'))).toBe('Only DevOps and admins change DevOps items.')
    expect(writeErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'Validation failed'))).toBe('That change could not be saved. Try again.')
    expect(writeErrorMessage(new TypeError('Failed to fetch'))).toBe('That change could not be saved. Try again.')
  })
})

describe('refetchKeysAfter', () => {
  it('refetches what a write touched and what depends on it, not everything', async () => {
    const { refetchKeysAfter } = await import('./queries')
    expect(refetchKeysAfter({ type: 'task.delete', id: '1' }).sort()).toEqual(['companies', 'entries', 'tasks', 'ticketDetails'].sort())
    const leave = refetchKeysAfter({ type: 'leave.decide', id: 'r1', status: 'Approved', by: 'A', when: '2026-10-14' })
    expect(leave).toEqual(expect.arrayContaining(['leave', 'leaveBook', 'notifications']))
    expect(leave).not.toContain('tasks')
  })
})

describe('heldRefetch (live updates during a write)', () => {
  it('keeps what changed while a write was in flight and refetches it once the write is done, instead of dropping it', async () => {
    const { heldRefetch } = await import('./queries')
    let busy = true
    const done: string[] = []
    const h = heldRefetch(() => busy, k => done.push(k))
    h.refetch(['tasks', 'companies'])
    h.refetch(['tasks'])
    expect(done).toEqual([])
    h.flush()
    expect(done).toEqual([])
    busy = false
    h.flush()
    expect(done.sort()).toEqual(['companies', 'tasks'])
    h.refetch(['leave'])
    expect(done).toContain('leave')
  })
})

describe('refetchKeysAfter: what other pages derive', () => {
  it('refreshes people when projects change and the reverse, and the timesheet when tickets change', async () => {
    const { refetchKeysAfter } = await import('./queries')
    expect(refetchKeysAfter({ type: 'project.internal.setState', id: 'i1', state: 'done' } as never)).toEqual(expect.arrayContaining(['people']))
    expect(refetchKeysAfter({ type: 'clientTeam.add', member: { id: 'x', companyId: 'c1', name: 'A', email: 'a@x' } })).toEqual(expect.arrayContaining(['people', 'companies']))
    expect(refetchKeysAfter({ type: 'task.delete', id: '1' })).toEqual(expect.arrayContaining(['entries']))
  })
})
