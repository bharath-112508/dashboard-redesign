import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get, post, patch, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, post, patch, put } }))
const { people } = vi.hoisted(() => ({ people: vi.fn() }))
vi.mock('./users', async importOriginal => ({ ...(await importOriginal<typeof import('./users')>()), fetchPeopleApi: people }))

const { fetchDevops, fetchQuestions, fetchRequests, linkEpics, datesIn, datesOut } = await import('./devops')

const NOW = new Date('2026-10-14T12:00:00.000Z')
const devops: Session = { personId: 'u9', name: 'Arjun', email: 'a@x', role: 'devops', org: 'Viljetech' }

beforeEach(() => {
  get.mockReset()
  people.mockReset()
})

describe('dates', () => {
  it('shows stored times as "ago", keeping the stored value to send back', () => {
    const out = datesOut({ logs: [{ text: 'x', when: '2026-10-14T11:55:00.000Z' }], notes: { 1: { when: 'Edited 2026-10-12T12:00:00.000Z' } }, rel: { when: '2026-10-09T13:12' } }, NOW)
    expect(out).toEqual({
      logs: [{ text: 'x', when: '5m ago', at: '2026-10-14T11:55:00.000Z' }],
      notes: { 1: { when: 'Edited 2d ago', at: 'Edited 2026-10-12T12:00:00.000Z' } },
      // A release time is a date the page formats itself: left alone.
      rel: { when: '2026-10-09T13:12' },
    })
  })

  it('stores "just now" as the time, and anything shown back as what was stored', () => {
    expect(datesIn({ pnotes: [{ when: 'Edited just now', at: '2026-10-01T00:00:00.000Z' }, { when: '3d ago', at: '2026-10-11T12:00:00.000Z' }] }, NOW)).toEqual({
      pnotes: [{ when: 'Edited 2026-10-14T12:00:00.000Z' }, { when: '2026-10-11T12:00:00.000Z' }],
    })
    expect(datesIn({ notes: { 0: { text: 'n', when: 'Just now' } } }, NOW)).toEqual({ notes: { 0: { text: 'n', when: '2026-10-14T12:00:00.000Z' } } })
  })
})

describe('fetchDevops', () => {
  it('reads the items as the board shapes them, and the design settings with the DevOps people until settings are saved', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/devops/items'
        ? [{ key: 'OPS-1', project_id: 'p1', data: { name: 'Intranet', project: { kind: 'internal', id: 'p1' }, logs: [] }, updated_at: '' }]
        : null,
    )
    people.mockResolvedValue([
      { id: 'u9', name: 'Arjun', role: 'devops', active: true },
      { id: 'u1', name: 'Rahul', role: 'dev', active: true },
      { id: 'u8', name: 'Gone', role: 'devops', active: false },
    ])
    const db = await fetchDevops(devops)
    expect(db.projects).toEqual([{ name: 'Intranet', project: { kind: 'internal', id: 'p1' }, logs: [], key: 'OPS-1' }])
    expect(db.settings.people).toEqual(['Arjun'])
    expect(db.settings.ladder.length).toBeGreaterThan(0)
  })

  it('uses saved settings as they are', async () => {
    get.mockImplementation(async (path: string) => (path === '/devops/items' ? [] : { ladder: [], people: ['Vivek'] }))
    expect((await fetchDevops(devops)).settings).toEqual({ ladder: [], people: ['Vivek'] })
    expect(people).not.toHaveBeenCalled()
  })
})

describe('linkEpics', () => {
  it("links each epic to the DevOps item on the epic's project", () => {
    const projectOfEpic = new Map([['s1', 'p1'], ['none~p2', 'p2'], ['s3', 'p3']])
    const items = [{ key: 'OPS-1', project: { kind: 'internal', id: 'p1' } }, { key: 'OPS-2', project: { kind: 'client', companyId: 'c', id: 'p2' } }]
    expect(linkEpics(['s1', 'none~p2', 's3'], projectOfEpic, items as never)).toEqual({ s1: 'OPS-1', 'none~p2': 'OPS-2' })
  })
})

describe('fetchQuestions', () => {
  it("maps a question and takes the client's first message as the answer", async () => {
    get.mockResolvedValue([
      {
        number: 3,
        title: 'DNS',
        text: 'Please grant access',
        by: 'Arjun',
        created_at: '2026-10-13T12:00:00.000Z',
        task_id: null,
        devops_key: 'OPS-1',
        sprint: null,
        photos: [],
        qtype: 'Access',
        qprio: 'High',
        from_devops: true,
        solved: false,
        seen_t: 0,
        messages: [
          { who: 'Arjun', side: 'team', text: 'Any news?', files: [], when: '2026-10-14T10:00:00.000Z' },
          { who: 'Johan', side: 'client', text: 'Done', files: [], when: '2026-10-14T11:00:00.000Z' },
        ],
      },
    ])
    const [q] = await fetchQuestions(devops, NOW)
    expect(q).toMatchObject({
      id: 3,
      by: 'Arjun',
      title: 'DNS',
      when: '1d ago',
      task: null,
      project: 'OPS-1',
      fromDevops: true,
      answer: 'Done',
      answerBy: 'Johan',
      answerIdx: 1,
      answeredWhen: '1h ago',
    })
    expect(q.comments?.[0]).toEqual({ who: 'Arjun', side: 'team', text: 'Any news?', files: [], when: '2h ago' })
  })
})

describe('fetchRequests', () => {
  it('maps a request with its comments, history and time logs', async () => {
    get.mockResolvedValue([
      {
        number: 2,
        devops_key: 'OPS-1',
        pname: 'Intranet',
        rkey: 'REQ-2',
        type: 'Access',
        prio: 'High',
        to: 'Arjun',
        text: 'Need staging',
        desc: '',
        due: '',
        start: '',
        est: '',
        by: 'Rahul',
        raised: '2026-10-13',
        status: 'Open',
        comments: [{ by: 'Arjun', text: 'On it', when: '2026-10-14T11:00:00.000Z', side: 'devops' }],
        history: [{ by: 'Arjun', text: 'Status changed', when: '2026-10-14T11:30:00.000Z' }],
        logs: [{ h: 2, by: 'Arjun', when: '2026-10-14T11:00:00.000Z', date: '2026-10-14' }],
        seen_t: 1,
        status_seen: 'Open',
        created_at: '2026-10-13T12:00:00.000Z',
      },
    ])
    const [r] = await fetchRequests(devops, NOW)
    expect(r).toMatchObject({ id: 2, key: 'OPS-1', rkey: 'REQ-2', by: 'Rahul', when: '1d ago', status: 'Open', seenT: 1, statusSeen: 'Open' })
    expect(r.comments).toEqual([{ by: 'Arjun', text: 'On it', when: '1h ago', side: 'devops' }])
    expect(r.history).toEqual([{ by: 'Arjun', text: 'Status changed', when: '30m ago' }])
    expect(r.logs?.[0]).toMatchObject({ h: 2, when: '1h ago', at: '2026-10-14T11:00:00.000Z' })
  })
})
