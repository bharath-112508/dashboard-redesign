import { describe, expect, it, vi } from 'vitest'
import type { ClientProject, Company } from '../../api/types'

const mode = vi.hoisted(() => ({ apiMode: false }))
vi.mock('../../api/http/config', () => mode)

const { IM_BUG_EPIC, IM_EPIC_IDS, IM_PROJECT, imBugEpic, imEpicIds, imProjectOf, isImProject } = await import('./data')

const project = (over: Partial<ClientProject>): ClientProject => ({ ...IM_PROJECT, ...over })
const company = (id: string, projects: ClientProject[]) => ({ id, projects }) as unknown as Company

describe('the InvoiceMatch project', () => {
  it("is Daco's fixed project in mock mode, with its fixed epics", () => {
    mode.apiMode = false
    expect(isImProject(IM_PROJECT)).toBe(true)
    expect(isImProject(project({ id: 'x1' }))).toBe(false)
    expect(imEpicIds(IM_PROJECT)).toEqual(IM_EPIC_IDS)
    expect(imBugEpic(IM_PROJECT)).toBe(IM_BUG_EPIC)
  })

  it('is the project named InvoiceMatch in API mode, with its own epics; bugs go to "Review & reports"', () => {
    mode.apiMode = true
    const real = project({ id: 'p9', epics: [{ id: 's1', name: 'Matching engine', state: 'done', pct: 100, sprints: 0 }, { id: 's2', name: 'Review & reports', state: 'done', pct: 100, sprints: 0 }] })
    const found = imProjectOf([company('c0', [project({ id: 'p1', name: 'Other' })]), company('c1', [real])])
    expect(found?.company.id).toBe('c1')
    expect(found?.project.id).toBe('p9')
    expect(imEpicIds(real)).toEqual(['s1', 's2', 'none~p9'])
    expect(imBugEpic(real)).toBe('s2')
    expect(imEpicIds(undefined)).toEqual([])
  })
})
