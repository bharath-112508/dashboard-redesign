import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get } }))

const { ago, fetchTicketDetails, historyLine } = await import('./ticketDetails')
const { boardIndex } = await import('./board')

const ID = '6ace39ef63d8ea9a59dcf3a7'
const NOW = new Date('2026-10-13T12:00:00.000Z')

describe('ago', () => {
  it('reads like the board: just now, minutes, hours, days, then the date', () => {
    expect(ago('2026-10-13T11:59:40.000Z', NOW)).toBe('just now')
    expect(ago('2026-10-13T11:55:00.000Z', NOW)).toBe('5m ago')
    expect(ago('2026-10-13T09:00:00.000Z', NOW)).toBe('3h ago')
    expect(ago('2026-10-11T12:00:00.000Z', NOW)).toBe('2d ago')
    expect(ago('2026-09-09T12:00:00.000Z', NOW)).toBe('09 Sep 2026')
  })
})

describe('historyLine', () => {
  const row = (activity_type: string, from_value: unknown = null, to_value: unknown = null) => ({ activity_type, from_value, to_value })

  it('says what changed', () => {
    boardIndex.statusNames.set('prog', 'In progress')
    expect(historyLine(row('created'))).toBe('created the task')
    expect(historyLine(row('status_changed', 'to_do', 'in_progress'))).toBe('moved it to In progress')
    expect(historyLine(row('title_changed', 'A', 'B'))).toBe('renamed it to “B”')
    expect(historyLine(row('priority_changed', 'low', 'critical'))).toBe('set priority to Critical')
    expect(historyLine(row('due_date_changed', null, '2026-10-20'))).toBe('set the due date to 20 Oct 2026')
    expect(historyLine(row('due_date_changed', '2026-10-20', null))).toBe('removed the due date')
    expect(historyLine(row('attachment_added'))).toBe('added an attachment')
    expect(historyLine(row('issue_type_changed', 'task', 'bug'))).toBe('changed the type to Bug')
  })

  it('leaves comment events out (the comment itself is shown) and unknown types too', () => {
    expect(historyLine(row('comment_added'))).toBeNull()
    expect(historyLine(row('something_new'))).toBeNull()
  })
})

describe('fetchTicketDetails', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('merges comments and history newest first, and lists attachments', async () => {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith(`/tasks/${ID}/comments`))
        return [{ id: 'c1', body: 'Looks good', author: { id: 'u1', full_name: 'Chary' }, created_at: '2026-10-12T10:00:00.000Z' }]
      if (path.startsWith(`/tasks/${ID}/activity`))
        return [
          { id: 'a2', activity_type: 'comment_added', actor: { full_name: 'Chary' }, created_at: '2026-10-12T10:00:00.000Z' },
          { id: 'a1', activity_type: 'created', actor: { full_name: 'Rahul' }, created_at: '2026-10-10T08:00:00.000Z' },
        ]
      if (path.startsWith(`/tasks/${ID}/attachments`))
        return [{ id: 'f1', file_name: 'spec.pdf', file_size: 12_300, created_at: '2026-10-11T09:00:00.000Z' }]
      throw new Error(`unexpected ${path}`)
    })
    const d = await fetchTicketDetails(ID, NOW)
    expect(d.acts).toEqual([
      { kind: 'comment', who: 'Chary', text: 'Looks good', when: '1d ago' },
      { kind: 'history', who: 'Rahul', what: 'created the task', when: '3d ago' },
    ])
    expect(d.atts).toEqual([{ id: 'f1', name: 'spec.pdf', size: '12 KB', date: '11 Oct 2026' }])
  })

  it('asks nothing for a ticket the backend does not have yet', async () => {
    expect(await fetchTicketDetails('3', NOW)).toEqual({ acts: [], atts: [] })
    expect(get).not.toHaveBeenCalled()
  })
})
