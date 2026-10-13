import { describe, expect, it } from 'vitest'
import { fmt } from './dates'

describe('fmt', () => {
  it('formats an ISO date with a zero-padded day', () => {
    expect(fmt('2026-10-09')).toBe('09 Oct 2026')
  })
})
