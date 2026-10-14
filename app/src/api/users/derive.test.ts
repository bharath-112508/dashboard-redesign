import { describe, expect, it } from 'vitest'
import { projectsToSave, offersAllProjects } from './derive'

describe('projectsToSave', () => {
  it('keeps the picks that are in the project list', () => {
    expect(projectsToSave(['p1', 'p9'], ['p1', 'p2'], true)).toEqual(['p1'])
  })

  it('keeps every pick while the project list is still loading, so saving early never removes project access', () => {
    expect(projectsToSave(['p1', 'p9'], [], false)).toEqual(['p1', 'p9'])
  })
})

describe('offersAllProjects', () => {
  it('in API mode, only for roles the backend shows every (company) project to', () => {
    expect((['super', 'pm', 'cadmin'] as const).every(r => offersAllProjects(r, true))).toBe(true)
    expect((['dev', 'devops', 'cuser'] as const).some(r => offersAllProjects(r, true))).toBe(false)
    expect(offersAllProjects('dev', false)).toBe(true)
    // A project manager who is a team lead on the server sees only their projects (the list shows which).
    expect(offersAllProjects('pm', true, ['p1'])).toBe(false)
    expect(offersAllProjects('pm', true, 'all')).toBe(true)
  })
})
