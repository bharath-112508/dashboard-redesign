import { describe, expect, it } from 'vitest'
import {
  clientProjectFrom,
  companyFrom,
  companyRoleFrom,
  companyRoleTo,
  contactFrom,
  epicFromStory,
  internalProjectFrom,
  stateFromStatus,
  statusFromState,
  type BackendCompany,
  type BackendProject,
} from './companyMappers'
import type { ProjectState } from '../types'

const project = (over: Partial<BackendProject> = {}): BackendProject => ({
  id: 'p1',
  name: 'Driver app',
  description: 'Mobile app for drivers',
  status: 'active',
  is_archived: false,
  start_date: '2026-09-01',
  end_date: '2026-12-20',
  member_ids: ['u1', 'u2'],
  company_id: 'c1',
  task_count: 8,
  done_task_count: 3,
  ...over,
})

describe('project states', () => {
  it.each<[string, ProjectState]>([
    ['active', 'active'],
    ['completed', 'done'],
    ['on_hold', 'hold'],
    ['planned', 'planned'],
    ['maintenance', 'maint'],
  ])('backend %s is app %s, and back', (status, state) => {
    expect(stateFromStatus(status)).toBe(state)
    expect(statusFromState(state)).toBe(status)
  })

  it('reads an unknown status as active', () => {
    expect(stateFromStatus('something_new')).toBe('active')
  })
})

describe('company roles', () => {
  it.each([
    ['super_admin', 'Super admin'],
    ['admin', 'Admin'],
    ['developer', 'Developer'],
    ['viewer', 'Viewer'],
  ] as const)('%s is %s, and back', (role, label) => {
    expect(companyRoleFrom(role)).toBe(label)
    expect(companyRoleTo(label)).toBe(role)
  })
})

describe('epicFromStory', () => {
  it.each([
    ['done', 'done'],
    ['empty', 'planned'],
    ['to_do', 'planned'],
    ['blocked', 'hold'],
    ['in_progress', 'active'],
  ] as const)('derived status %s is state %s', (derived, state) => {
    expect(
      epicFromStory({ id: 's1', title: 'Web app', derived_status: derived, progress_percent: 40, sprint_ids: ['a', 'b'] }),
    ).toEqual({ id: 's1', name: 'Web app', state, pct: 40, sprints: 2 })
  })
})

describe('clientProjectFrom', () => {
  it('maps fields, rounds progress from the task counts and keeps the epics', () => {
    const epics = [{ id: 's1', name: 'Web app', state: 'active' as const, pct: 40, sprints: 2 }]
    expect(clientProjectFrom(project(), epics)).toEqual({
      id: 'p1',
      name: 'Driver app',
      desc: 'Mobile app for drivers',
      state: 'active',
      pct: 38,
      start: '2026-09-01',
      due: '2026-12-20',
      team: ['u1', 'u2'],
      epics,
    })
  })

  it('reads a project with no tasks as 0%, no end date as an empty due date, and maps the support plan', () => {
    const p = clientProjectFrom(
      project({ task_count: 0, done_task_count: 0, end_date: null, status: 'maintenance', support_plan: { until: '2027-06-30', quota_hours: 20 } }),
      [],
    )
    expect(p).toMatchObject({ pct: 0, due: '', state: 'maint', sup: { until: '2027-06-30', quota: 20, used: 0 } })
  })

  it('leaves out the support plan when there is none', () => {
    expect('sup' in clientProjectFrom(project({ support_plan: null }), [])).toBe(false)
  })
})

describe('internalProjectFrom', () => {
  it('maps an internal project, with an empty area when it was never set', () => {
    expect(internalProjectFrom(project({ company_id: null, area: undefined }))).toEqual({
      id: 'p1',
      name: 'Driver app',
      desc: 'Mobile app for drivers',
      area: '',
      state: 'active',
      pct: 38,
      start: '2026-09-01',
      due: '2026-12-20',
      team: ['u1', 'u2'],
    })
  })
})

describe('contactFrom', () => {
  it('maps a client admin with their title and projects', () => {
    expect(
      contactFrom({ id: 'u7', full_name: 'Ingrid', email: 'i@daco.no', role: 'client', status: 'active', title: 'CTO', projects: [{ id: 'p1', name: 'A', code: 'A' }] }),
    ).toEqual({ personId: 'u7', name: 'Ingrid', role: 'CTO', email: 'i@daco.no', projects: ['p1'], admin: true })
  })

  it('maps a representative without a title', () => {
    expect(contactFrom({ id: 'u8', full_name: 'Lars', email: 'l@daco.no', role: 'representative', status: 'active', projects: [] })).toEqual({
      personId: 'u8',
      name: 'Lars',
      role: '',
      email: 'l@daco.no',
      projects: [],
      admin: false,
    })
  })
})

describe('companyFrom', () => {
  const legacy: BackendCompany = { id: 'c1', name: 'Aurora Foods AB', status: 'active' }

  it('reads a company saved before the profile fields existed with empty defaults', () => {
    const c = companyFrom(legacy, [], [])
    expect(c).toMatchObject({
      id: 'c1',
      name: 'Aurora Foods AB',
      industry: '',
      country: '',
      web: '',
      notes: '',
      contacts: [],
      projects: [],
      ourRoles: {},
      archived: false,
      archivedAt: null,
    })
    expect(c.logo).toBeUndefined()
    expect(Number.isInteger(c.p) && c.p >= 0).toBe(true)
  })

  it('maps the profile, staff roles and the archive date', () => {
    const c = companyFrom(
      {
        ...legacy,
        status: 'archived',
        industry: 'Food',
        country: 'Sweden',
        website: 'aurora.example',
        notes: 'n',
        logo: 'data:image/png;base64,AA',
        archived_at: '2026-10-01T08:30:00.000Z',
        responsibles: [{ user_id: 'u1', role: 'developer' }],
      },
      [],
      [],
    )
    expect(c).toMatchObject({
      industry: 'Food',
      web: 'aurora.example',
      logo: 'data:image/png;base64,AA',
      archived: true,
      archivedAt: '2026-10-01',
      ourRoles: { u1: 'Developer' },
    })
  })

  it('gives the same company the same colour every time', () => {
    expect(companyFrom(legacy, [], []).p).toBe(companyFrom({ ...legacy }, [], []).p)
  })
})
