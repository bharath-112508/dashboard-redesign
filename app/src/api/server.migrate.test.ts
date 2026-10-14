import { describe, expect, it } from 'vitest'
import { stringEntryIds, stringLeaveIds, stringPersonIds, stringTaskIds } from './server'

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

describe('stringTaskIds (DB version 6)', () => {
  const v5 = {
    version: 5,
    tasks: [
      { id: 12, title: 'Login', deps: [3, '4'], subs: [{ t: 'a', done: false, sid: 1201 }, { t: 'b', done: true }] },
      { id: 1201, title: 'a', parent: 12, deps: [], subs: [] },
    ],
    entries: [{ id: 1, task: 12, bill: 2 }, { id: 2, task: null, area: 'Admin' }],
    questions: [{ id: 3, task: 12, title: 'Q' }],
  }

  it('turns every stored ticket id into a string and keeps the rest of each record', () => {
    const v6 = stringTaskIds(v5) as typeof v5
    expect(v6.tasks[0]).toEqual({ id: '12', title: 'Login', deps: ['3', '4'], subs: [{ t: 'a', done: false, sid: '1201' }, { t: 'b', done: true }] })
    expect(v6.tasks[1]).toMatchObject({ id: '1201', parent: '12' })
    expect(v6.entries).toEqual([{ id: 1, task: '12', bill: 2 }, { id: 2, task: null, area: 'Admin' }])
    expect(v6.questions[0]).toEqual({ id: 3, task: '12', title: 'Q' })
  })

  it('leaves ids that are already strings alone, so running it twice changes nothing', () => {
    const once = stringTaskIds(v5)
    expect(stringTaskIds(once)).toEqual(once)
  })
})

describe('stringEntryIds (DB version 7)', () => {
  const v6 = { version: 6, entries: [{ id: 4, task: '12', bill: 2 }, { id: '5', task: null, area: 'Admin' }] }

  it('turns time entry ids into strings and keeps the rest', () => {
    expect((stringEntryIds(v6) as typeof v6).entries).toEqual([{ id: '4', task: '12', bill: 2 }, { id: '5', task: null, area: 'Admin' }])
  })

  it('changes nothing the second time', () => {
    const once = stringEntryIds(v6)
    expect(stringEntryIds(once)).toEqual(once)
  })
})

describe('stringLeaveIds (DB version 8)', () => {
  const v7 = { version: 7, leave: [{ id: 2, userId: '3', type: 'Annual' }, { id: '5', userId: '4', type: 'Sick' }] }

  it('turns leave request ids into strings and keeps the rest', () => {
    expect((stringLeaveIds(v7) as typeof v7).leave).toEqual([{ id: '2', userId: '3', type: 'Annual' }, { id: '5', userId: '4', type: 'Sick' }])
  })

  it('changes nothing the second time', () => {
    const once = stringLeaveIds(v7)
    expect(stringLeaveIds(once)).toEqual(once)
  })
})
