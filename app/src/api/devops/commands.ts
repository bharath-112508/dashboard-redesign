import type { Db } from '../types'
import type { Resource } from '../commands'
import type { DvLog, DvProject, DvSettings } from './types'

/** Who makes changes on the DevOps board. */
const ME = 'Rahul'

/** Commands only the DevOps board sends. */
export type DevopsCommand =
  | { type: 'devops.project.create'; project: DvProject }
  /** Changes a project; `log` adds an Activity entry (newest first). */
  | {
      type: 'devops.project.update'
      key: string
      patch: Partial<DvProject>
      log?: Omit<DvLog, 'by' | 'when'> & { by?: string; when?: string }
    }
  /**
   * Adds an option picked with "+ New …" in Details. New statuses go to
   * Settings → Statuses (with their description), new dev phases to the default phases.
   */
  | { type: 'devops.option.add'; field: string; value: string; desc?: string }
  /**
   * Saves Settings. `renames` maps old names to new ones so projects follow a
   * renamed status, follow-up step or dev phase; projects on removed ones move.
   */
  | {
      type: 'devops.settings.save'
      settings: DvSettings
      renames: { statuses: Record<string, string>; ladder: Record<string, string>; dev: Record<string, string> }
    }

export const touchesDevops = (cmd: { type: string }): Resource[] => (cmd.type.startsWith('devops.') ? ['devops'] : [])

const isDevops = (cmd: { type: string }): cmd is DevopsCommand => cmd.type.startsWith('devops.')

export const reduceDevops = (db: Db, c: { type: string }): Db => {
  if (!isDevops(c)) return db
  const dv = db.devops
  const cmd = c
  switch (cmd.type) {
    case 'devops.project.create':
      return { ...db, devops: { ...dv, projects: [cmd.project, ...dv.projects.filter(p => p.key !== cmd.project.key)] } }

    case 'devops.project.update':
      return {
        ...db,
        devops: {
          ...dv,
          projects: dv.projects.map(p =>
            p.key !== cmd.key
              ? p
              : {
                  ...p,
                  ...cmd.patch,
                  logs: cmd.log ? [{ by: ME, when: 'Just now', ...cmd.log }, ...p.logs] : p.logs,
                },
          ),
        },
      }

    case 'devops.option.add': {
      const s = dv.settings
      const v = cmd.value
      if (cmd.field === 'infra') {
        if (s.statuses.some(x => x.name === v)) return db
        return { ...db, devops: { ...dv, settings: { ...s, statuses: [...s.statuses, { name: v, desc: cmd.desc || '' }] } } }
      }
      if (cmd.field === 'dev') {
        if (s.devPhases.some(x => x.name === v)) return db
        return { ...db, devops: { ...dv, settings: { ...s, devPhases: [...s.devPhases, { name: v, days: null }] } } }
      }
      const cur = s.options[cmd.field] || []
      if (cur.includes(v)) return db
      return { ...db, devops: { ...dv, settings: { ...s, options: { ...s.options, [cmd.field]: [...cur, v] } } } }
    }

    case 'devops.settings.save': {
      const old = dv.settings
      const next = cmd.settings
      const R = cmd.renames
      const statusNames = next.statuses.map(x => x.name)
      const ladderNames = next.ladder.map(x => x.name)
      const devNames = next.devPhases.map(x => x.name)
      const projects = dv.projects.map(p => {
        const patch: Partial<DvProject> = {}
        if (statusNames.length) {
          const nv = R.statuses[p.infra] ?? (statusNames.includes(p.infra) ? p.infra : statusNames[0])
          if (nv !== p.infra) patch.infra = nv
        }
        if (p.step != null) {
          let idx: number
          if (p.step < old.ladder.length) {
            const nn = R.ladder[old.ladder[p.step].name]
            idx = nn ? ladderNames.indexOf(nn) : -1
            if (idx < 0) idx = Math.min(p.step, ladderNames.length - 1)
          } else idx = ladderNames.length + (p.step - old.ladder.length)
          patch.step = idx
          patch.act = idx < ladderNames.length ? ladderNames[idx] : (p.xsteps || [])[idx - ladderNames.length]?.name ?? p.act
        }
        if (p.dev && p.dev !== 'Not set') {
          const nv = R.dev[p.dev] ?? (devNames.includes(p.dev) ? p.dev : 'Not set')
          if (nv !== p.dev) patch.dev = nv
        }
        return Object.keys(patch).length ? { ...p, ...patch } : p
      })
      return { ...db, devops: { ...dv, settings: next, projects } }
    }
  }
}
