import type { Db, InternalProject, ProjectState } from '../types'
import type { Resource } from '../commands'

/**
 * Commands for internal projects (the company's own tools, infra and website).
 * Client projects are under their company; see api/companies/commands.ts.
 */
export type ProjectsCommand =
  | { type: 'project.internal.create'; project: InternalProject }
  | { type: 'project.internal.setState'; id: string; state: ProjectState }

export const touchesProjects = (cmd: { type: string }): Resource[] => {
  switch (cmd.type) {
    case 'project.internal.create':
    case 'project.internal.setState':
      return ['internalProjects']
    default:
      return []
  }
}

export const reduceProjects = (db: Db, cmd: { type: string }): Db => {
  const c = cmd as ProjectsCommand
  switch (c.type) {
    case 'project.internal.create':
      return {
        ...db,
        internalProjects: [c.project, ...db.internalProjects.filter(p => p.id !== c.project.id)],
      }
    case 'project.internal.setState':
      return {
        ...db,
        internalProjects: db.internalProjects.map(p => (p.id === c.id ? { ...p, state: c.state } : p)),
      }
    default:
      return db
  }
}
