import { describe, expect, it } from 'vitest'
import { stringPersonIds } from './server'

describe('stringPersonIds (DB version 5)', () => {
  const v4 = {
    version: 4,
    people: [{ id: 3, name: 'Chary' }],
    entries: [{ id: 1, userId: 3, date: '2026-10-06', bill: 2, non: 0 }],
    weekSubmissions: [{ userId: 3, week: '2026-10-05' }],
    leave: [{ id: 1, userId: 4 }],
    notifications: [{ id: 2, userId: 3 }],
    companies: [{ id: 'daco', contacts: [{ personId: 7, name: 'Ingrid' }, { personId: null, name: 'Guest' }], projects: [{ id: 'dacop', team: [3, 4] }] }],
    internalProjects: [{ id: 'i1', team: [1] }],
  }

  it('turns every stored person id into a string and keeps the rest of each record', () => {
    const v5 = stringPersonIds(v4) as typeof v4
    expect(v5.people[0]).toEqual({ id: '3', name: 'Chary' })
    expect(v5.entries[0]).toEqual({ id: 1, userId: '3', date: '2026-10-06', bill: 2, non: 0 })
    expect(v5.weekSubmissions[0].userId).toBe('3')
    expect(v5.leave[0].userId).toBe('4')
    expect(v5.notifications[0].userId).toBe('3')
    expect(v5.companies[0].contacts.map(c => c.personId)).toEqual(['7', null])
    expect(v5.companies[0].projects[0].team).toEqual(['3', '4'])
    expect(v5.internalProjects[0].team).toEqual(['1'])
  })

  it('leaves ids that are already strings alone, so running it twice changes nothing', () => {
    const once = stringPersonIds(v4)
    expect(stringPersonIds(once)).toEqual(once)
  })
})
