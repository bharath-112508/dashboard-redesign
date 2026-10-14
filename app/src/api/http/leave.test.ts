import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, post } }))

const { fetchLeave, fetchLeaveNotices, fetchLeaveBook, sendLeaveCommand, isLeaveApiCommand } = await import('./leave')

const admin: Session = { personId: 'a0', name: 'Vilje Admin', email: 'a@x', role: 'super', org: 'Viljetech' }
const dev: Session = { personId: 'u1', name: 'Rahul', email: 'r@x', role: 'dev', org: 'Viljetech' }
const client: Session = { personId: 'k1', name: 'Johan', email: 'j@x', role: 'cuser', org: 'Aurora', orgId: 'c1' }

const req = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: 'u1',
  user: { id: 'u1', full_name: 'Rahul' },
  requested_leave_type: { id: 'lt-cl', code: 'CL', name: 'Casual Leave' },
  start_date: '2026-11-02',
  end_date: '2026-11-03',
  reason: 'Family',
  status: 'pending',
  acted_at: null,
  ...extra,
})

const TYPES = [
  { id: 'lt-cl', code: 'CL', name: 'Casual Leave', is_unlimited: false, is_earned: false },
  { id: 'lt-sl', code: 'SL', name: 'Sick Leave', is_unlimited: false, is_earned: false },
  { id: 'lt-wfh', code: 'WFH', name: 'Work From Home', is_unlimited: true, is_earned: false },
]

beforeEach(() => {
  get.mockReset()
  post.mockReset()
})

describe('fetchLeave', () => {
  it('reads an admin\'s view and their own requests, without cancelled ones', async () => {
    get.mockImplementation(async (path: string) =>
      path.includes('user_id=a0') ? [req('r3', { user_id: 'a0', user: { id: 'a0', full_name: 'Vilje Admin' } })] : [req('r1'), req('r2', { status: 'cancelled' })],
    )
    const out = await fetchLeave(admin)
    expect(get.mock.calls.map(c => c[0])).toEqual(['/leaves?limit=100&page=1', '/leaves?user_id=a0&limit=100&page=1'])
    expect(out.map(r => [r.id, r.userId, r.type, r.status])).toEqual([
      ['r1', 'u1', 'Casual Leave', 'Pending'],
      ['r3', 'a0', 'Casual Leave', 'Pending'],
    ])
  })

  it('reads a manager\'s own requests too (the backend\'s manager list is their reports only)', async () => {
    const pm: Session = { ...dev, personId: 'm1', role: 'pm' }
    get.mockResolvedValue([])
    await fetchLeave(pm)
    expect(get.mock.calls.map(c => c[0])).toEqual(['/leaves?limit=100&page=1', '/leaves?user_id=m1&limit=100&page=1'])
  })

  it('reads a developer\'s own requests once', async () => {
    get.mockResolvedValueOnce([req('r1', { status: 'approved', acted_at: '2026-10-12T10:00:00.000Z' })])
    const [r] = await fetchLeave(dev)
    expect(get).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ status: 'Approved', from: '2026-11-02', to: '2026-11-03', decidedWhen: '2026-10-12' })
  })

  it('reads nothing for a client', async () => {
    expect(await fetchLeave(client)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})

describe('fetchLeaveNotices', () => {
  it('builds the notices from decided requests, as the design words them', async () => {
    get.mockResolvedValueOnce([req('r1', { status: 'approved', acted_at: '2026-10-12T10:00:00.000Z' }), req('r2')])
    const notes = await fetchLeaveNotices(dev)
    expect(notes).toEqual([expect.objectContaining({ userId: 'u1', kind: 'leave', text: 'Your Casual Leave, 2 Nov – 3 Nov, was approved.', when: '12 Oct 2026' })])
  })
})

describe('fetchLeaveBook', () => {
  it('uses the backend\'s types and the main type\'s balance for the signed-in person', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/leave-types') return TYPES
      if (path.startsWith('/leave-balances/me'))
        return [
          { leave_type: { id: 'lt-cl', code: 'CL', name: 'Casual Leave', is_unlimited: false, is_earned: false }, allocated: 15, carried_forward: 2, adjusted: 0, used: 3, pending: 1, available: 13 },
          { leave_type: { id: 'lt-sl', code: 'SL', name: 'Sick Leave', is_unlimited: false, is_earned: false }, allocated: 12, carried_forward: 0, adjusted: 0, used: 0, pending: 0, available: 12 },
        ]
      throw new Error(path)
    })
    expect(await fetchLeaveBook('u1', dev)).toEqual({ types: ['Casual Leave', 'Sick Leave', 'Work From Home'], main: 'Casual Leave', allowance: 17, used: 3, pending: 1, left: 14 })
  })

  it('reads another person\'s balance through the team route', async () => {
    get.mockImplementation(async (path: string) => (path === '/leave-types' ? TYPES : []))
    await fetchLeaveBook('u1', admin)
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/^\/leave-balances\?user_id=u1&year=\d{4}$/))
  })
})

describe('sendLeaveCommand', () => {
  beforeEach(() => {
    get.mockImplementation(async (path: string) => (path === '/leave-types' ? TYPES : []))
    post.mockResolvedValue({ id: 'r9' })
  })

  it('takes the leave commands', () => {
    expect(isLeaveApiCommand({ type: 'leave.create' })).toBe(true)
    expect(isLeaveApiCommand({ type: 'leave.decide' })).toBe(true)
    expect(isLeaveApiCommand({ type: 'user.update' })).toBe(false)
  })

  it('applies for the person on the profile, by type, with the type as the reason when none is given', async () => {
    const out = await sendLeaveCommand(
      { type: 'leave.create', request: { id: '1', userId: 'u1', type: 'Work From Home', from: '2026-12-01', to: '2026-12-01', reason: '', status: 'Pending' } },
      admin,
    )
    expect(out).toEqual({ id: 'r9' })
    expect(post).toHaveBeenCalledWith('/leaves', { leave_type_id: 'lt-wfh', start_date: '2026-12-01', end_date: '2026-12-01', reason: 'Work From Home', user_id: 'u1' })
  })

  it('applies for yourself without naming you', async () => {
    await sendLeaveCommand({ type: 'leave.create', request: { id: '1', userId: 'u1', type: 'Casual Leave', from: '2026-12-01', to: '2026-12-02', reason: 'Trip', status: 'Pending' } }, dev)
    expect(post.mock.calls[0][1]).not.toHaveProperty('user_id')
  })

  it('approves, and rejects with the remarks the backend needs', async () => {
    await sendLeaveCommand({ type: 'leave.decide', id: 'r1', status: 'Approved', by: 'Vilje Admin', when: '2026-10-14' }, admin)
    expect(post).toHaveBeenCalledWith('/leaves/r1/approve', {})
    await sendLeaveCommand({ type: 'leave.decide', id: 'r1', status: 'Rejected', by: 'Vilje Admin', when: '2026-10-14' }, admin)
    expect(post).toHaveBeenCalledWith('/leaves/r1/reject', { approver_remarks: 'Rejected by Vilje Admin' })
  })
})
