import { describe, expect, it } from 'vitest'
import { projectsToSave } from './derive'

describe('projectsToSave', () => {
  it('keeps the picks that are in the project list', () => {
    expect(projectsToSave(['p1', 'p9'], ['p1', 'p2'], true)).toEqual(['p1'])
  })

  it('keeps every pick while the project list is still loading, so saving early never removes project access', () => {
    expect(projectsToSave(['p1', 'p9'], [], false)).toEqual(['p1', 'p9'])
  })
})
