import { describe, expect, it } from 'vitest'
import { compareTaskIds, findTicket, ticketIdFromParam } from './tasks'
import type { Task } from '../api/types'

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

describe('findTicket', () => {
  const tasks = [{ id: '6ace39ef63d8ea9a59dcf3a7', subKey: 'RTP-2' }, { id: '12' }] as unknown as Task[]

  it('finds a ticket by id, by its draft alias, or by its key (My tickets links use the key)', () => {
    expect(findTicket(tasks, '12')?.id).toBe('12')
    expect(findTicket(tasks, 'draft-1', '12')?.id).toBe('12')
    expect(findTicket(tasks, 'RTP-2')?.id).toBe('6ace39ef63d8ea9a59dcf3a7')
    expect(findTicket(tasks, 'NOPE-1')).toBeUndefined()
  })
})

describe('withDetails', () => {
  it("puts the backend's comments, history, attachments and bug chat on a ticket; unsent chat messages stay after them", async () => {
    const { withDetails } = await import('./tasks')
    const bug = { id: 't1', acts: [], atts: [], clientBug: { reported: 'x', chat: [{ who: 'Emma', side: 'client', text: 'sending…', when: 'just now', files: [] }] } } as unknown as Task
    const details = { acts: [{ kind: 'comment', who: 'Rahul', text: 'hi', when: '1h ago' }], atts: [], chat: [{ who: 'Rahul', side: 'team', text: 'hi', when: '1h ago', files: [] }] }
    const out = withDetails(bug, details as never)!
    expect(out.acts).toEqual(details.acts)
    expect(out.clientBug?.chat.map(m => m.text)).toEqual(['hi', 'sending…'])
    expect(withDetails(bug, undefined)).toBe(bug)
    expect(withDetails(undefined, details as never)).toBeUndefined()
  })
})
