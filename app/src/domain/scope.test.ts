import { describe, expect, it } from 'vitest'
import type { Company, Workspace } from '../api/types'
import { buildScope } from './scope'

describe('buildScope', () => {
  it("covers a client's project epics and, in API mode, each project's No epic group (where their own bug reports land)", () => {
    const companies = [{ id: 'c1', projects: [{ id: 'p1', epics: [{ id: 's1' }] }] }, { id: 'c2', projects: [{ id: 'p2', epics: [{ id: 's2' }] }] }] as unknown as Company[]
    const ws = { epics: [{ id: 's1' }, { id: 'none~p1' }, { id: 's2' }, { id: 'none~p2' }], sprints: [], statuses: [], devopsLinks: {} } as unknown as Workspace
    expect(buildScope('c1', companies, ws).epicIds).toEqual(['s1', 'none~p1'])
  })
})
