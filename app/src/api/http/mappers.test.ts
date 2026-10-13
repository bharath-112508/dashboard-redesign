import { describe, expect, it } from 'vitest'
import { personFromUser, roleFromBackend, sessionFromMe, type BackendUser } from './mappers'

describe('roleFromBackend', () => {
  it.each([
    ['admin', [], 'super'],
    ['manager', [], 'pm'],
    ['team_lead', [], 'pm'],
    ['employee', [], 'dev'],
    ['client', [], 'cadmin'],
    ['representative', [], 'cuser'],
    ['employee', ['employee', 'devops'], 'devops'],
    ['team_lead', ['devops'], 'devops'],
    ['admin', ['admin', 'devops'], 'super'],
    ['client', ['devops'], 'cadmin'],
    ['something_new', [], 'dev'],
  ])('%s with keys %j is %s', (role, keys, expected) => {
    expect(roleFromBackend(role, keys)).toBe(expected)
  })
})

const staff: BackendUser = {
  id: 'u1',
  full_name: 'Asha Rao',
  email: 'asha@viljetech.com',
  role: 'employee',
  status: 'active',
  timezone: 'Asia/Kolkata',
  phone: '+91 1',
  internal_profile: { employment_type: 'freelancer' },
  last_login_at: null,
}

describe('personFromUser', () => {
  it('maps a staff member', () => {
    const p = personFromUser(staff)
    expect(p).toMatchObject({
      id: 'u1',
      name: 'Asha Rao',
      email: 'asha@viljetech.com',
      org: 'vt',
      role: 'dev',
      emp: 'freelancer',
      active: true,
      phone: '+91 1',
      tz: 'Asia/Kolkata',
      projects: 'all',
      last: 'Never',
    })
    expect(p.colour).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('puts a client representative in their company and marks a deactivated person inactive', () => {
    const p = personFromUser({
      ...staff,
      id: 'u2',
      role: 'representative',
      status: 'deactivated',
      client_profile: { company_id: 'c1' },
      internal_profile: undefined,
      last_login_at: '2026-10-01T10:00:00Z',
    })
    expect(p).toMatchObject({ org: 'c1', role: 'cuser', active: false })
    expect(p.emp).toBeUndefined()
    expect(p.last).not.toBe('Never')
  })

  it('treats a staff member with no employment type as an employee-less record (no emp field)', () => {
    expect(personFromUser({ ...staff, internal_profile: { employment_type: null } }).emp).toBeUndefined()
    expect(personFromUser({ ...staff, internal_profile: { employment_type: 'staff' } }).emp).toBe('employee')
  })

  it('gives the same person the same colour every time', () => {
    expect(personFromUser(staff).colour).toBe(personFromUser({ ...staff }).colour)
  })
})

describe('sessionFromMe', () => {
  it('builds a client session named after the company', () => {
    const s = sessionFromMe({
      id: 'u2',
      email: 'l@daco.no',
      full_name: 'Lars',
      role: 'representative',
      role_keys: ['representative'],
      timezone: 'Europe/Oslo',
      employment_type: null,
      company_id: 'c1',
      company_name: 'Daco',
      phone: null,
    })
    expect(s).toEqual({ personId: 'u2', name: 'Lars', email: 'l@daco.no', role: 'cuser', org: 'Daco', orgId: 'c1', tz: 'Europe/Oslo' })
  })

  it('builds a staff session', () => {
    const s = sessionFromMe({
      id: 'u1',
      email: 'a@viljetech.com',
      full_name: 'Asha',
      role: 'admin',
      role_keys: ['admin'],
      timezone: 'Asia/Kolkata',
      employment_type: 'staff',
      company_id: null,
      company_name: null,
      phone: '+91 1',
    })
    expect(s).toEqual({
      personId: 'u1',
      name: 'Asha',
      email: 'a@viljetech.com',
      role: 'super',
      org: 'Viljetech',
      emp: 'employee',
      phone: '+91 1',
      tz: 'Asia/Kolkata',
    })
  })
})
