import type { Db } from '../types'
import type { Resource } from '../commands'
import { escalationIndex } from './rules'
import type { DvLog, DvProject, DvRules, DvSettings } from './types'

/**
 * Commands only the DevOps board sends. The reducer here is the only place
 * that decides what a write does: the UI, the optimistic cache update and the
 * mock server all run it, so a locked date cannot be changed by any caller.
 */
export type DevopsCommand =
  /** Creates a project. Refused (no change) when the key exists or there is no initial due date. */
  | { type: 'devops.project.create'; project: DvProject }
  /**
   * Changes a project. `by` is the signed-in person: it becomes `updatedBy`
   * and the author of the Activity entry in `log` (newest first).
   */
  | {
      type: 'devops.project.update'
      key: string
      by: string
      patch: Partial<DvProject>
      log?: Omit<DvLog, 'by' | 'when'>
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

/**
 * Keeps the stored value of every date that is fixed once set, whatever the
 * patch says. A date the rules do not lock is taken from the patch.
 */
export const applyLocks = (p: DvProject, patch: Partial<DvProject>, rules: DvRules): Partial<DvProject> => {
  const out: Partial<DvProject> = { ...patch }
  if (rules.lockInitial && p.initDue && 'initDue' in out) out.initDue = p.initDue
  if (rules.lockDevDue) {
    // Every entry in devDues is a phase due date that was saved, so it stays.
    const fixed = p.devDues ?? {}
    if (Object.keys(fixed).length || out.devDues) out.devDues = { ...(out.devDues ?? {}), ...fixed }
    const phase = out.dev ?? p.dev
    const pinned = phase ? out.devDues?.[phase] : undefined
    if (pinned && 'devDue' in out) out.devDue = pinned
  }
  return out
}

/** Old step index → new step index in the saved ladder, or -1 when a default step was removed. */
const stepMap = (old: DvSettings, next: DvSettings, renamed: Record<string, string>) => {
  const names = next.ladder.map(x => x.name)
  return (i: number): number => {
    if (i >= old.ladder.length) return names.length + (i - old.ladder.length)
    const nn = renamed[old.ladder[i].name]
    return nn ? names.indexOf(nn) : -1
  }
}

const remapKeys = <V>(rec: Record<number, V> | undefined, to: (i: number) => number) => {
  if (!rec) return undefined
  const out: Record<number, V> = {}
  for (const [k, v] of Object.entries(rec)) {
    const j = to(+k)
    if (j >= 0) out[j] = v
  }
  return out
}

export const reduceDevops = (db: Db, c: { type: string }): Db => {
  if (!isDevops(c)) return db
  const dv = db.devops
  const cmd = c
  switch (cmd.type) {
    case 'devops.project.create': {
      const { project } = cmd
      if (dv.projects.some(p => p.key === project.key) || !project.initDue) return db
      return { ...db, devops: { ...dv, projects: [project, ...dv.projects] } }
    }

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
                  ...applyLocks(p, cmd.patch, dv.settings.rules),
                  updatedBy: cmd.by,
                  logs: cmd.log ? [{ ...cmd.log, by: cmd.by, when: 'Just now' }, ...p.logs] : p.logs,
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
      const R = cmd.renames
      const statusNames = cmd.settings.statuses.map(x => x.name)
      const ladderNames = cmd.settings.ladder.map(x => x.name)
      const devNames = cmd.settings.devPhases.map(x => x.name)
      const toStep = stepMap(old, cmd.settings, R.ladder)

      // Escalation follows its step by name; if that step was removed, the nearest one by position takes over.
      const escName = cmd.settings.rules.escStep
      const escOk = escName && ladderNames.includes(escName) ? escName : ladderNames[Math.min(escalationIndex(old), ladderNames.length - 1)]
      const next: DvSettings = {
        ...cmd.settings,
        rules: { ...cmd.settings.rules, escStep: escOk, esc: ladderNames.indexOf(escOk) },
      }

      const projects = dv.projects.map(p => {
        const patch: Partial<DvProject> = {}
        if (statusNames.length) {
          const nv = R.statuses[p.infra] ?? (statusNames.includes(p.infra) ? p.infra : statusNames[0])
          if (nv !== p.infra) patch.infra = nv
        }
        if (p.step != null) {
          let idx = toStep(p.step)
          if (idx < 0) idx = Math.min(p.step, ladderNames.length - 1)
          patch.step = idx
          patch.act = idx < ladderNames.length ? ladderNames[idx] : (p.xsteps || [])[idx - ladderNames.length]?.name ?? p.act
        }
        // Dates and notes are kept by step index, so they move with their step.
        if (p.dates) patch.dates = remapKeys(p.dates, toStep)
        if (p.notes) patch.notes = remapKeys(p.notes, toStep)
        if (p.dev && p.dev !== 'Not set') {
          const nv = R.dev[p.dev] ?? (devNames.includes(p.dev) ? p.dev : 'Not set')
          if (nv !== p.dev) patch.dev = nv
        }
        if (p.devDues && Object.keys(R.dev).length) {
          patch.devDues = Object.fromEntries(Object.entries(p.devDues).map(([k, v]) => [R.dev[k] ?? k, v]))
        }
        if (p.devPlan && Object.keys(R.dev).length) {
          patch.devPlan = Object.fromEntries(Object.entries(p.devPlan).map(([k, v]) => [R.dev[k] ?? k, v]))
        }
        return { ...p, ...patch }
      })
      return { ...db, devops: { ...dv, settings: next, projects } }
    }
  }
}
