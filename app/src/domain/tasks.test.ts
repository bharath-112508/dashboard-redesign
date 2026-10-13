import { describe, expect, it } from 'vitest'
import { compareTaskIds, ticketIdFromParam } from './tasks'

describe('ticketIdFromParam', () => {
  it('reads a number, a PMT key, a backend id and a subtask id', () => {
    expect(ticketIdFromParam('12')).toBe('12')
    expect(ticketIdFromParam('PMT-12')).toBe('12')
    expect(ticketIdFromParam('6ace39ef63d8ea9a59dcf3a7')).toBe('6ace39ef63d8ea9a59dcf3a7')
    expect(ticketIdFromParam('10.1')).toBe('10.1')
    expect(ticketIdFromParam('6ace39ef63d8ea9a59dcf3a7.2')).toBe('6ace39ef63d8ea9a59dcf3a7.2')
  })

  it('refuses anything else', () => {
    expect(ticketIdFromParam('<script>')).toBeNull()
    expect(ticketIdFromParam(null)).toBeNull()
  })
})

describe('compareTaskIds', () => {
  it('orders number ids as numbers and backend ids by creation', () => {
    expect(['10', '9', '100'].sort(compareTaskIds)).toEqual(['9', '10', '100'])
    expect(['65a000000000000000000000', '650000000000000000000000'].sort(compareTaskIds)).toEqual(['650000000000000000000000', '65a000000000000000000000'])
  })
})
