import { describe, expect, it } from 'vitest'
import { entryBody, entryFrom, minutesSplit, type BackendEntry } from './timesheetMappers'
import type { TimeEntry } from '../types'

const readCtx = {
  userName: (id: string) => ({ u1: 'Chary' })[id] ?? '',
  projectRef: (id: string | null) => (id === 'p1' ? 'c:p1' : id === 'p9' ? 'i:p9' : undefined),
  epicOfTask: (id: string) => (id === 't1' ? 'e1' : undefined),
  taskTitle: (id: string) => (id === 't1' ? 'Login' : ''),
}

const be = (over: Partial<BackendEntry> = {}): BackendEntry => ({
  id: 'x1',
  user_id: 'u1',
  local_date: '2026-10-12',
  entry_type: 'general',
  project_id: 'p9',
  task_id: null,
  general_category: 'Payroll module',
  billable_total_minutes: 105,
  non_billable_total_minutes: 30,
  description: 'Fixed the export',
  work_type: 'Review',
  ...over,
})

describe('minutesSplit', () => {
  it('splits decimal hours into whole hours and minutes', () => {
    expect(minutesSplit(1.75)).toEqual({ hours: 1, minutes: 45 })
    expect(minutesSplit(0.25)).toEqual({ hours: 0, minutes: 15 })
    expect(minutesSplit(0)).toEqual({ hours: 0, minutes: 0 })
    expect(minutesSplit(2)).toEqual({ hours: 2, minutes: 0 })
  })
})

describe('entryFrom', () => {
  it('maps a text entry', () => {
    expect(entryFrom(be(), readCtx)).toEqual({
      id: 'x1',
      date: '2026-10-12',
      userId: 'u1',
      user: 'Chary',
      type: 'Review',
      task: null,
      area: 'Payroll module',
      project: 'i:p9',
      notes: 'Fixed the export',
      bill: 1.75,
      non: 0.5,
    })
  })

  it('maps a ticket entry with its epic, and prefers the name the backend sends', () => {
    const e = entryFrom(be({ entry_type: 'task_linked', task_id: 't1', project_id: 'p1', general_category: null, user: { id: 'u1', full_name: 'Chary R' } }), readCtx)
    expect(e).toMatchObject({ task: 't1', epic: 'e1', project: 'c:p1', user: 'Chary R' })
    expect(e.area).toBeUndefined()
  })

  it('reads a description that only stood in for an empty note as no note', () => {
    expect(entryFrom(be({ description: 'Payroll module' }), readCtx).notes).toBe('')
    expect(entryFrom(be({ entry_type: 'task_linked', task_id: 't1', general_category: null, description: 'Login' }), readCtx).notes).toBe('')
  })

  it('reads an entry with no work type as General', () => {
    expect(entryFrom(be({ work_type: null }), readCtx).type).toBe('General')
  })
})

describe('entryBody', () => {
  const writeCtx = {
    projectId: (ref: string | undefined) => (ref ? ref.slice(2) : null),
    projectOfTask: (id: string) => (id === 't1' ? 'p1' : null),
    taskTitle: (id: string) => (id === 't1' ? 'Login' : ''),
  }
  const app = (over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: '',
    date: '2026-10-12',
    userId: 'u1',
    user: 'Chary',
    type: 'Meeting',
    task: null,
    area: 'Standup',
    project: 'i:p9',
    notes: '',
    bill: 0,
    non: 1.5,
    ...over,
  })

  it('sends a text entry as a general entry on its project', () => {
    expect(entryBody(app(), writeCtx)).toEqual({
      entry_type: 'general',
      project_id: 'p9',
      general_category: 'Standup',
      local_date: '2026-10-12',
      work_type: 'Meeting',
      description: 'Standup',
      billable_hours: 0,
      billable_minutes: 0,
      non_billable_hours: 1,
      non_billable_minutes: 30,
    })
  })

  it('sends a ticket entry with the ticket\'s project, and its title when there is no note', () => {
    expect(entryBody(app({ task: 't1', area: undefined, project: undefined, bill: 2, non: 0 }), writeCtx)).toMatchObject({
      entry_type: 'task_linked',
      task_id: 't1',
      project_id: 'p1',
      description: 'Login',
      billable_hours: 2,
    })
  })

  it('keeps a written note as the description', () => {
    expect(entryBody(app({ notes: 'Planned the sprint' }), writeCtx).description).toBe('Planned the sprint')
  })
})
