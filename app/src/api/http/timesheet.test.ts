import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get, liveProjects, fetchTasks } = vi.hoisted(() => ({ get: vi.fn(), liveProjects: vi.fn(), fetchTasks: vi.fn(async () => []) }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get } }))
vi.mock('./companies', async importOriginal => ({ ...(await importOriginal<typeof import('./companies')>()), liveProjects }))
vi.mock('./board', () => ({
  fetchTasks,
  boardIndex: { tasks: new Map([['t1', { id: 't1', title: 'Login', epic: 'e1' }]]), projectOfTask: new Map([['t1', 'p1']]) },
}))

const { fetchEntries, fetchWeekSubmissions, rangeStart } = await import('./timesheet')

const dev: Session = { personId: 'u1', name: 'Chary', email: 'c@x', role: 'dev', org: 'Viljetech' }
const pm: Session = { ...dev, personId: 'u2', name: 'Rahul', role: 'pm' }
const client: Session = { ...dev, personId: 'k1', role: 'cuser', org: 'Aurora', orgId: 'c1' }

const entry = (id: string, user_id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id,
  local_date: '2026-10-12',
  entry_type: 'task_linked',
  project_id: 'p1',
  task_id: 't1',
  general_category: null,
  billable_total_minutes: 60,
  non_billable_total_minutes: 0,
  description: 'Login',
  work_type: 'General',
  ...extra,
})

const FROM = '2026-08-31'

beforeEach(() => {
  get.mockReset()
  liveProjects.mockReset()
  liveProjects.mockResolvedValue([
    { id: 'p1', company_id: 'c1' },
    { id: 'p9', company_id: null },
  ])
})

describe('rangeStart', () => {
  it('is the Monday on or before the first day of the previous month, so a straddling week is whole', () => {
    expect(rangeStart(new Date('2026-10-13T12:00:00'))).toBe('2026-08-31')
    expect(rangeStart(new Date('2026-07-20T12:00:00'))).toBe('2026-06-01')
  })
})

describe('fetchEntries', () => {
  it('reads only a developer\'s own entries', async () => {
    get.mockImplementation(async (path: string) => (path.startsWith('/timesheets/me') ? [entry('x1', 'u1')] : Promise.reject(new Error(path))))
    const out = await fetchEntries(dev)
    expect(get.mock.calls.map(c => c[0])).toEqual([`/timesheets/me?from_date=${FROM}&limit=100&page=1`])
    expect(out).toEqual([
      expect.objectContaining({ id: 'x1', userId: 'u1', user: 'Chary', task: 't1', epic: 'e1', project: 'c:p1', notes: '', bill: 1 }),
    ])
  })

  it('adds the team for a manager, without doubles', async () => {
    get.mockImplementation(async (path: string) =>
      path.startsWith('/timesheets/me')
        ? [entry('x2', 'u2')]
        : [entry('x2', 'u2', { user: { id: 'u2', full_name: 'Rahul' } }), entry('x3', 'u1', { user: { id: 'u1', full_name: 'Chary' } })],
    )
    const out = await fetchEntries(pm)
    expect(get).toHaveBeenCalledWith(`/timesheets?from_date=${FROM}&limit=100&page=1`)
    expect(out.map(e => [e.id, e.user])).toEqual([
      ['x2', 'Rahul'],
      ['x3', 'Chary'],
    ])
  })

  it('does not wait for the ticket board, and names tickets from the entry itself', async () => {
    get.mockResolvedValueOnce([entry('x1', 'u1', { task_id: 't7', description: 'Payments', task: { id: 't7', title: 'Payments' } })])
    const [e] = await fetchEntries(dev)
    expect(fetchTasks).not.toHaveBeenCalled()
    expect(e.notes).toBe('')
  })

  it('reads nothing for a client', async () => {
    expect(await fetchEntries(client)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('reads nothing when nobody is signed in', async () => {
    expect(await fetchEntries(null)).toEqual([])
  })
})

describe('fetchWeekSubmissions', () => {
  it('maps submitted weeks', async () => {
    get.mockResolvedValueOnce([{ id: 'w1', user_id: 'u1', week_start: '2026-10-05', submitted_at: '2026-10-09T12:05:00.000Z' }])
    const [w] = await fetchWeekSubmissions(dev)
    expect(get).toHaveBeenCalledWith(`/timesheets/weeks?from_date=${FROM}`)
    expect(w).toMatchObject({ userId: 'u1', week: '2026-10-05' })
    expect(w.when).toMatch(/^09 Oct 2026, \d{2}:\d{2}$/)
  })

  it('reads nothing for a client', async () => {
    expect(await fetchWeekSubmissions(client)).toEqual([])
  })
})
