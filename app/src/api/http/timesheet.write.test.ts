import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, TimeEntry } from '../types'

const { post, put, del } = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), del: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { post, put, delete: del } }))
vi.mock('./board', () => ({
  boardIndex: { tasks: new Map([['t1', { id: 't1', title: 'Login', epic: 'e1' }]]), projectOfTask: new Map([['t1', 'p1']]) },
}))

const { isTimeApiCommand, sendTimeCommand } = await import('./timesheet')

const me: Session = { personId: 'u1', name: 'Chary', email: 'c@x', role: 'dev', org: 'Viljetech' }
const boss: Session = { ...me, personId: 'u2', role: 'pm' }
const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: '',
  date: '2026-10-12',
  userId: 'u1',
  user: 'Chary',
  type: 'General',
  task: 't1',
  notes: 'Wired the SDK',
  bill: 1.5,
  non: 0,
  ...over,
})

beforeEach(() => {
  for (const m of [post, put, del]) m.mockReset()
  post.mockResolvedValue({ id: 'x9' })
})

describe('isTimeApiCommand', () => {
  it('takes the time and week commands', () => {
    for (const type of ['time.log', 'time.remove', 'week.submit', 'week.reopen']) expect(isTimeApiCommand({ type })).toBe(true)
    expect(isTimeApiCommand({ type: 'task.update' })).toBe(false)
  })
})

describe('sendTimeCommand', () => {
  it('logs time and returns the backend id', async () => {
    expect(await sendTimeCommand({ type: 'time.log', entry: entry() }, me)).toEqual({ id: 'x9' })
    expect(post).toHaveBeenCalledWith('/timesheets', expect.objectContaining({ entry_type: 'task_linked', task_id: 't1', project_id: 'p1', billable_hours: 1, billable_minutes: 30 }))
  })

  it('refuses logging time for someone else, before calling anything', async () => {
    await expect(sendTimeCommand({ type: 'time.log', entry: entry({ userId: 'u7' }) }, boss)).rejects.toMatchObject({
      status: 403,
      message: 'You can only log your own time.',
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('removes an entry', async () => {
    await sendTimeCommand({ type: 'time.remove', id: '6ace39ef63d8ea9a59dcf3a7' }, me)
    expect(del).toHaveBeenCalledWith('/timesheets/6ace39ef63d8ea9a59dcf3a7')
  })

  it('refuses removing an entry that is still being saved', async () => {
    await expect(sendTimeCommand({ type: 'time.remove', id: '3' }, me)).rejects.toMatchObject({ status: 403 })
    expect(del).not.toHaveBeenCalled()
  })

  it('submits and reopens the person\'s own week', async () => {
    await sendTimeCommand({ type: 'week.submit', submission: { userId: 'u1', week: '2026-10-05', when: 'now' } }, me)
    expect(put).toHaveBeenCalledWith('/timesheets/weeks/2026-10-05', {})
    await sendTimeCommand({ type: 'week.reopen', userId: 'u1', week: '2026-10-05' }, me)
    expect(del).toHaveBeenCalledWith('/timesheets/weeks/2026-10-05')
  })

  it('reopens someone else\'s week by naming them', async () => {
    await sendTimeCommand({ type: 'week.reopen', userId: 'u1', week: '2026-10-05' }, boss)
    expect(del).toHaveBeenCalledWith('/timesheets/weeks/2026-10-05?user_id=u1')
  })
})
