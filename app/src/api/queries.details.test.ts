import { describe, expect, it, vi } from 'vitest'

vi.mock('./http/config', () => ({ apiMode: false, API_URL: '' }))
const { ticketDetailsQuery } = await import('./queries')

describe('ticketDetailsQuery', () => {
  it('never asks in mock mode: the mock keeps comments and history on the ticket', () => {
    expect(ticketDetailsQuery('6ace39ef63d8ea9a59dcf3a7')).toMatchObject({ queryKey: ['ticketDetails', '6ace39ef63d8ea9a59dcf3a7'], enabled: false })
  })
})
