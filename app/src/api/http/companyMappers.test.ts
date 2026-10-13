import { describe, expect, it } from 'vitest'
import { COMPANIES_SEED } from '../companies/seed'
import {
  clientProjectFrom,
  companyBody,
  companyFrom,
  companyRoleFrom,
  companyRoleTo,
  contactFrom,
  epicFromStory,
  internalProjectFrom,
  projectBody,
  responsiblesBody,
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

// ─── App → backend request bodies ────────────────────────────────────────

describe('companyBody', () => {
  it('renames web to website and passes the other profile fields through', () => {
    expect(companyBody({ name: 'Aurora', web: 'aurora.example', industry: 'Food', country: 'SE', notes: 'n', logo: '' })).toEqual({
      name: 'Aurora',
      website: 'aurora.example',
      industry: 'Food',
      country: 'SE',
      notes: 'n',
      logo: '',
    })
  })

  it('sends only the fields that were given', () => {
    expect(companyBody({ notes: 'x' })).toEqual({ notes: 'x' })
  })
})

describe('responsiblesBody', () => {
  it('turns company roles into the backend list', () => {
    expect(responsiblesBody({ u1: 'Developer', u2: 'Super admin' })).toEqual([
      { user_id: 'u1', role: 'developer' },
      { user_id: 'u2', role: 'super_admin' },
    ])
  })
})

describe('projectBody', () => {
  const seedProject = COMPANIES_SEED[0].projects[0]

  it('maps a client project, and a project read back from the backend matches it', () => {
    const body = projectBody(seedProject, 'c1', '2026-10-13')
    expect(body).toMatchObject({
      name: seedProject.name,
      description: seedProject.desc,
      status: statusFromState(seedProject.state),
      member_ids: seedProject.team,
      company_id: 'c1',
    })
    const back = clientProjectFrom(
      {
        id: 'p1',
        name: body.name as string,
        description: body.description as string,
        status: body.status as string,
        is_archived: false,
        start_date: body.start_date as string,
        end_date: body.end_date as string | null,
        member_ids: body.member_ids as string[],
        company_id: 'c1',
      },
      [],
    )
    expect(back).toMatchObject({ name: seedProject.name, desc: seedProject.desc, state: seedProject.state, due: seedProject.due, team: seedProject.team })
  })

  it('uses today when there is no start date and null when there is no due date', () => {
    const body = projectBody({ ...seedProject, start: undefined, due: '' }, 'c1', '2026-10-13')
    expect(body.start_date).toBe('2026-10-13')
    expect(body.end_date).toBeNull()
  })

  it('sends the support plan only when there is one, and the area for an internal project', () => {
    expect('support_plan' in projectBody({ ...seedProject, sup: undefined }, 'c1', '2026-10-13')).toBe(false)
    expect(projectBody({ ...seedProject, sup: { until: '2027-06-30', quota: 20, used: 3 } }, 'c1', '2026-10-13').support_plan).toEqual({
      until: '2027-06-30',
      quota_hours: 20,
    })
    const internal = { id: 'i1', name: 'Infra', desc: '', area: 'Ops', state: 'active' as const, pct: 0, due: '', team: [] }
    expect(projectBody(internal, null, '2026-10-13')).toMatchObject({ area: 'Ops', company_id: null })
  })
})
