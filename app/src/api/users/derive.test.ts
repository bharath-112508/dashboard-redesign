import { describe, expect, it } from 'vitest'
import { projectsToSave, offersAllProjects, accessToSave } from './derive'

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
    expect(offersAllProjects('pm', true, ['p1'], 'pm')).toBe(false)
    expect(offersAllProjects('pm', true, 'all', 'pm')).toBe(true)
    // A developer made a project manager becomes a manager on the server, who sees every project.
    expect(offersAllProjects('pm', true, ['p1'], 'dev')).toBe(true)
  })
})

describe('accessToSave', () => {
  it("keeps someone's projects when \"All projects\" no longer applies and none are ticked", () => {
    // A manager made a developer, nothing ticked: leave their projects as they are.
    expect(accessToSave('all', [], false)).toBe('all')
    expect(accessToSave('all', ['p1'], false)).toBe('pick')
    expect(accessToSave('all', [], true)).toBe('all')
    expect(accessToSave('pick', [], false)).toBe('pick')
  })
})
