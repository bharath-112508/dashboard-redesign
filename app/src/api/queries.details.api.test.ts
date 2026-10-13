import { describe, expect, it, vi } from 'vitest'

vi.mock('./http/config', () => ({ apiMode: true, API_URL: 'http://x/api/v1' }))
const { ticketDetailsQuery } = await import('./queries')
const { ApiError } = await import('./http/client')

describe('ticketDetailsQuery in API mode', () => {
  it('asks only for tickets the backend has (a draft keeps its own fields)', () => {
    expect(ticketDetailsQuery('6ace39ef63d8ea9a59dcf3a7').enabled).toBe(true)
    expect(ticketDetailsQuery('3').enabled).toBe(false)
  })

  it('does not retry a refusal, only a server or network failure', () => {
    const { retry } = ticketDetailsQuery('6ace39ef63d8ea9a59dcf3a7')
    expect(retry(0, new ApiError(403, 'FORBIDDEN', 'no'))).toBe(false)
    expect(retry(0, new ApiError(503, 'DOWN', 'down'))).toBe(true)
    expect(retry(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(retry(3, new TypeError('Failed to fetch'))).toBe(false)
  })
})
