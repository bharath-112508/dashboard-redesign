import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'
import { createDevopsSeed } from '../devops/seed'

const { get, post, patch, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, post, patch, put } }))

const { isDevopsApiCommand, sendDevopsCommand } = await import('./devops')

const NOW = new Date('2026-10-14T12:00:00.000Z')
const me: Session = { personId: 'u9', name: 'Arjun', email: 'a@x', role: 'devops', org: 'Viljetech' }

beforeEach(() => {
  for (const f of [get, post, patch, put]) f.mockReset()
  post.mockResolvedValue({})
  patch.mockResolvedValue({})
  put.mockResolvedValue({})
})

describe('isDevopsApiCommand', () => {
  it('takes DevOps, question and request commands, and batches of them', () => {
    expect(isDevopsApiCommand({ type: 'devops.project.update' })).toBe(true)
    expect(isDevopsApiCommand({ type: 'question.message' })).toBe(true)
    expect(isDevopsApiCommand({ type: 'tickets.question.seen' })).toBe(true)
    expect(isDevopsApiCommand({ type: 'request.comment' })).toBe(true)
    expect(isDevopsApiCommand({ type: 'batch', cmds: [{ type: 'question.update' }, { type: 'question.message' }] })).toBe(true)
    expect(isDevopsApiCommand({ type: 'batch', cmds: [{ type: 'question.update' }, { type: 'task.update' }] })).toBe(false)
    expect(isDevopsApiCommand({ type: 'task.update' })).toBe(false)
  })
})

describe('DevOps board', () => {
  it('creates an item on its project, with "just now" stored as the time', async () => {
    const project = { key: 'OPS-3', name: 'Intranet', project: { kind: 'internal', id: 'p1' }, logs: [{ type: 'Action', by: 'Arjun', when: 'Just now', text: 'Added' }] }
    await sendDevopsCommand({ type: 'devops.project.create', project: project as never }, me, NOW)
    expect(post).toHaveBeenCalledWith('/devops/items', {
      key: 'OPS-3',
      project_id: 'p1',
      data: { name: 'Intranet', project: { kind: 'internal', id: 'p1' }, logs: [{ type: 'Action', by: 'Arjun', when: '2026-10-14T12:00:00.000Z', text: 'Added' }] },
    })
  })

  it('sends a change with its log line; the backend writes who and when', async () => {
    await sendDevopsCommand(
      { type: 'devops.project.update', key: 'OPS-3', by: 'Arjun', patch: { prio: 'High' }, log: { type: 'Field change', text: 'Priority changed to High' } },
      me,
      NOW,
    )
    expect(patch).toHaveBeenCalledWith('/devops/items/OPS-3', { patch: { prio: 'High' }, log: { type: 'Field change', text: 'Priority changed to High' } })
  })

  it('saves settings, then moves the items a rename touches', async () => {
    const settings = createDevopsSeed().settings
    const old = settings.statuses[0].name
    get.mockImplementation(async (path: string) =>
      path === '/devops/items'
        ? [
            { key: 'OPS-1', project_id: 'p1', data: { name: 'A', infra: old, logs: [] }, updated_at: '' },
            { key: 'OPS-2', project_id: 'p2', data: { name: 'B', infra: settings.statuses[1].name, logs: [] }, updated_at: '' },
          ]
        : settings,
    )
    const next = { ...settings, statuses: [{ ...settings.statuses[0], name: 'Renamed' }, ...settings.statuses.slice(1)] }
    await sendDevopsCommand({ type: 'devops.settings.save', settings: next, renames: { statuses: { [old]: 'Renamed' }, ladder: {}, dev: {} } }, me, NOW)
    expect(put).toHaveBeenCalledWith('/devops/settings', { settings: next })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('/devops/items/OPS-1', { patch: { infra: 'Renamed' } })
  })

  it('saves an option added from Details as a settings change', async () => {
    const settings = createDevopsSeed().settings
    get.mockImplementation(async (path: string) => (path === '/devops/items' ? [] : settings))
    await sendDevopsCommand({ type: 'devops.option.add', field: 'deploy', value: 'Blue/green' }, me, NOW)
    expect(put.mock.calls[0][1].settings.options.deploy).toContain('Blue/green')
  })
})

describe('questions', () => {
  it('raises a question with its links', async () => {
    await sendDevopsCommand(
      {
        type: 'question.create',
        question: { id: 7, by: 'Arjun', title: 'DNS', text: 'Grant access', photos: [], qtype: '', qprio: 'High', project: 'OPS-3', fromDevops: true, when: 'just now', task: null, answer: '', comments: [] },
      },
      me,
      NOW,
    )
    expect(post).toHaveBeenCalledWith('/questions', {
      number: 7,
      title: 'DNS',
      text: 'Grant access',
      photos: [],
      qtype: '',
      qprio: 'High',
      sprint: null,
      task_id: null,
      devops_key: 'OPS-3',
      from_devops: true,
    })
  })

  it('adds only the new photos (the ones read back are already stored)', async () => {
    const old = { name: 'a.png', size: '1 KB', url: 'data:a', img: true, saved: true }
    const added = { name: 'b.png', size: '1 KB', url: 'data:b', img: true }
    await sendDevopsCommand({ type: 'question.update', id: 7, patch: { photos: [old, added] as never } }, me, NOW)
    expect(post).toHaveBeenCalledWith('/questions/7/photos', { files: [added] })
    expect(patch).not.toHaveBeenCalled()
  })

  it('sends messages, edits, solved and seen', async () => {
    await sendDevopsCommand({ type: 'question.message', id: 7, message: { who: 'x', side: 'team', text: 'Hi', when: 'just now', files: [] } }, me, NOW)
    expect(post).toHaveBeenCalledWith('/questions/7/messages', { text: 'Hi', files: [] })
    await sendDevopsCommand({ type: 'question.editMessage', id: 7, index: 1, who: 'Arjun', text: 'Hello' }, me, NOW)
    expect(patch).toHaveBeenCalledWith('/questions/7/messages/1', { text: 'Hello' })
    await sendDevopsCommand({ type: 'batch', cmds: [{ type: 'question.update', id: 7, patch: { solved: true } }, { type: 'tickets.question.seen', id: 7, seen: 2 }] }, me, NOW)
    expect(patch).toHaveBeenCalledWith('/questions/7', { solved: true })
    expect(patch).toHaveBeenCalledWith('/questions/7', { seen_t: 2 })
  })
})

describe('DevOps requests', () => {
  it('raises, changes and replies', async () => {
    await sendDevopsCommand(
      {
        type: 'request.create',
        request: { id: 4, key: 'OPS-3', pname: 'Intranet', rkey: 'REQ-4', type: 'Access', prio: 'High', to: 'Arjun', text: 'Need staging', by: 'Rahul', when: 'just now', raised: '2026-10-14', status: 'Open', comments: [] },
      },
      me,
      NOW,
    )
    expect(post).toHaveBeenCalledWith('/devops-requests', {
      number: 4,
      devops_key: 'OPS-3',
      pname: 'Intranet',
      rkey: 'REQ-4',
      type: 'Access',
      prio: 'High',
      to: 'Arjun',
      text: 'Need staging',
      raised: '2026-10-14',
    })
    await sendDevopsCommand(
      { type: 'request.update', id: 4, patch: { status: 'Done', seenT: 1, statusSeen: 'Done', logs: [{ h: 2, by: 'Arjun', when: 'just now', date: '2026-10-14' }] }, log: { by: 'Arjun', text: 'Status changed to Done' } },
      me,
      NOW,
    )
    expect(patch).toHaveBeenCalledWith('/devops-requests/4', {
      patch: { status: 'Done', seen_t: 1, status_seen: 'Done', logs: [{ h: 2, by: 'Arjun', when: '2026-10-14T12:00:00.000Z', date: '2026-10-14' }] },
      log: { text: 'Status changed to Done' },
    })
    await sendDevopsCommand({ type: 'request.comment', id: 4, comment: { by: 'Arjun', text: 'Ready', when: 'just now', side: 'devops' } }, me, NOW)
    expect(post).toHaveBeenCalledWith('/devops-requests/4/comments', { text: 'Ready', side: 'devops' })
  })
})
