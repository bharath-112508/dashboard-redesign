/**
 * DevOps board data (projects, follow-up sequences, settings). Owned by the DevOps board page.
 *
 * Dates are ISO strings: "2026-10-12" for days and "2026-10-12T07:00" for
 * reminder times. The page formats them ("12 Oct 2026, 07:00").
 */

import type { ProjectRef } from '../types'

/** One line in a project's Activity tab. */
export interface DvLog {
  /** 'Field change' | 'Phase change' | 'Follow-up' | 'Action' | 'Note' | 'Action update' */
  type: string
  text: string
  detail?: string
  by: string
  when: string
}

/** A step of the internal (dev team) follow-up sequence the project has reached. */
export interface DvInternalStep {
  name: string
  /** ISO date the step is due. */
  date: string
  done?: boolean
  note?: string
}

/** A step added to one project's client sequence only. */
export interface DvExtraStep {
  name: string
  /** Hours from the start of the sequence. */
  off: number
}

export interface DvNote {
  id: number
  text: string
  by: string
  when: string
}

export interface DvProject {
  key: string
  /**
   * The project's name: a copy of the linked project's name, taken when the item is created
   * (projects cannot be renamed). Requests keep it as `pname`.
   */
  name: string
  /**
   * The project this DevOps item is (v5: DevOps is project specific): a client project inside its
   * company, or an internal project. Null only for an item saved before v5 whose project could not be found.
   */
  project: ProjectRef | null
  /** Follows the linked project's kind; the Sequence switch filters on this. */
  kind: 'client' | 'internal'
  /** The project's status (a name from settings.statuses). */
  infra: string
  /** This project's own description of its status; falls back to the status default. */
  infraNote?: string | null
  prio: string
  /** Who the next action is from: Client, Development team, DevOps or Not set. */
  from: string
  /** Current client follow-up step name, or 'Not required'. */
  act: string
  /** Index of the current client follow-up step; null when no client sequence runs. */
  step: number | null
  /** When step 1 of the client sequence is planned (ISO datetime); later steps follow the hour offsets. */
  seqStart?: string | null
  /** Dates changed by hand, by step index (ISO datetime). */
  dates?: Record<number, string>
  /** Steps added to this project's client sequence. */
  xsteps?: DvExtraStep[]
  /** "What happened" notes, by client step index. */
  notes?: Record<number, { text: string; when: string }>
  /** Internal sequence progress. */
  ifu?: DvInternalStep[]
  actDate?: string | null
  /** Next reminder (ISO datetime). */
  reminder?: string | null
  overdue: boolean
  initDue?: string | null
  /** Estimated deployment when it differs from the initial due date. */
  latestDue?: string | null
  /** How far the estimated deployment moved, e.g. "+20 d". */
  moved?: string | null
  reason?: string | null
  deploy: string
  depType?: string
  cicd?: boolean
  dev: string
  devDue?: string | null
  /** Fixed due dates of dev phases reached, by phase name. */
  devDues?: Record<string, string>
  /** Planned dates of later dev phases, by phase name. */
  devPlan?: Record<string, string>
  /** This project's own dev phase steps (null = the defaults in Settings). */
  devSteps?: string[] | null
  devOwner?: string | null
  devStepTitle?: string | null
  owner: string | null
  updatedBy: string
  /** DevOps phase. */
  phase?: string | null
  phaseDue?: string | null
  phaseWhen?: string | null
  next?: string | null
  nextStart?: string | null
  history?: { text: string; when: string; due?: string | null }[]
  pnotes?: DvNote[]
  /** Release history, shown under Deployments in the panel sidebar. */
  deploys?: DvDeployments | null
  /** ISO date the project was added. */
  added: string
  /** Newest first. */
  logs: DvLog[]
}

export interface DvRules {
  /** Index of the client step from which a project counts as escalated (see escalationIndex). */
  esc: number
  /** Name of that step; kept in step with renames in Settings. */
  escStep?: string
  requireNote: boolean
  requireReminder: boolean
  lockInitial: boolean
  requirePhaseDue: boolean
  /** "07:00": added to new reminder dates. */
  remTime: string
  requireDevDue: boolean
  lockDevDue: boolean
}

export interface DvSettings {
  /** Client follow-up sequence: each step's wait in hours after the previous one. */
  ladder: { name: string; hours: number }[]
  /** Internal follow-up sequence (dates are set at each step). */
  iladder: string[]
  statuses: { name: string; desc: string }[]
  /** Default dev phases with their typical duration in days. */
  devPhases: { name: string; days: number | null }[]
  rules: DvRules
  /** Options added from the Details dropdowns, by field. */
  options: Record<string, string[]>
  /** DevOps team members (owners and request assignees). */
  people: string[]
}

/** One release of a project, newest first in DvDeployments.rel. */
export interface DvRelease {
  v: string
  name: string
  st: 'Live' | 'Rolled back'
  /** ISO datetime of the release, e.g. "2026-10-09T13:12". */
  when: string
  note?: string
}

/** A project's release history (sample data; no command writes it yet). */
export interface DvDeployments {
  /** ISO date of the first go-live. */
  first: string
  rel: DvRelease[]
}

export interface DevopsDb {
  projects: DvProject[]
  settings: DvSettings
}
