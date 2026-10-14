import { describe, expect, it } from 'vitest'
import { fmt } from './dates'

describe('fmt', () => {
  it('formats an ISO date with a zero-padded day', () => {
    expect(fmt('2026-10-09')).toBe('09 Oct 2026')
  })
})

describe('todayFor', () => {
  it("is the design's fixed day in mock mode and the real local day in API mode", async () => {
    const { todayFor } = await import('./dates')
    expect(todayFor(false, new Date(2026, 9, 14, 0, 30))).toBe('2026-10-10')
    expect(todayFor(true, new Date(2026, 9, 14, 0, 30))).toBe('2026-10-14')
    expect(todayFor(true, new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
