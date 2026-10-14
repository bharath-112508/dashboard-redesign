import { describe, expect, it, vi } from 'vitest'
import { parseEvents, queryKeysFor, startLiveUpdates } from './live'

describe('parseEvents', () => {
  it('reads complete events and keeps a partial one for later', () => {
    const { events, rest } = parseEvents(': connected\n\nevent: change\ndata: {"topics":["tasks"]}\n\nevent: change\ndata: {"to')
    expect(events).toEqual([{ event: 'change', data: '{"topics":["tasks"]}' }])
    expect(rest).toBe('event: change\ndata: {"to')
  })

  it('ignores heartbeats', () => {
    expect(parseEvents(': ping\n\n').events).toEqual([])
  })
})

describe('queryKeysFor', () => {
  it('maps backend topics to the data the pages show, once each', () => {
    expect(queryKeysFor(['tasks', 'task-comments'])).toEqual(['tasks', 'ticketDetails', 'entries'])
    expect(queryKeysFor(['leaves'])).toEqual(['leave', 'notifications', 'leaveBook'])
    expect(queryKeysFor(['users', 'roles'])).toEqual(['people', 'access'])
    expect(queryKeysFor(['something-new'])).toEqual([])
  })
})

/** A response whose body streams the given chunks, then ends. */
const streamOf = (chunks: string[], status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(new TextEncoder().encode(x))
        c.close()
      },
    }),
    { status },
  )

describe('startLiveUpdates', () => {
  it('refreshes the data a change event names, with the token, batched', async () => {
    const seen: string[][] = []
    const fetchFn = vi.fn().mockResolvedValueOnce(
      streamOf(['event: change\ndata: {"topics":["tasks"]}\n\n', 'event: change\ndata: {"topics":["timesheets"]}\n\n']),
    )
    const stop = startLiveUpdates(keys => seen.push(keys), {
      fetchFn,
      token: () => 'tok',
      refreshToken: async () => undefined,
      wait: () => new Promise(() => {}), // never reconnects in this test
      batchMs: 0,
    })
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    stop()
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer tok', Accept: 'text/event-stream' })
    expect(seen.flat().sort()).toEqual(['entries', 'tasks', 'ticketDetails', 'weekSubmissions', 'companies'].sort())
  })

  it('refreshes the token and reconnects after a 401', async () => {
    const refreshToken = vi.fn(async () => undefined)
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(streamOf([]))
    let waits = 0
    const stop = startLiveUpdates(() => {}, {
      fetchFn,
      token: () => 'tok',
      refreshToken,
      wait: () => (++waits > 1 ? new Promise(() => {}) : Promise.resolve()),
      batchMs: 0,
    })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    stop()
    expect(refreshToken).toHaveBeenCalled()
  })

  it('does not connect while nobody is signed in', async () => {
    const fetchFn = vi.fn()
    const stop = startLiveUpdates(() => {}, { fetchFn, token: () => null, refreshToken: async () => undefined, wait: () => new Promise(() => {}), batchMs: 0 })
    await new Promise(r => setTimeout(r, 10))
    stop()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
