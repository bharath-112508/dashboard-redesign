import { fmt } from '../../lib/dates'
import type { Epic, Priority, Sprint, SprintState, Subtask, Task, TaskType } from '../types'
import { hashOf } from './mappers'

/** A task as the backend returns it (`GET /projects/:id/tasks`). */
export interface BackendTask {
  id: string
  project_id: string
  task_number?: number
  sprint_id: string | null
  story_id: string | null
  parent_task_id: string | null
  title: string
  description: string
  status: string
  priority: string
  issue_type: string
  labels: string[]
  due_date: string | null
  start_date?: string | null
  estimated_hours: number
  assignee_ids: string[]
  primary_assignee_id: string | null
  collaborator_ids: string[]
  source?: 'client' | null
  depends_on_task_ids: string[]
  created_at: string
}

/** A story (the app's epic), with the redesign's epic document fields. */
export interface BackendStory {
  id: string
  project_id: string
  title: string
  description?: string
  goal?: string
  user_story?: string
  criteria?: string[]
  criteria_done?: number[]
  target_date?: string | null
  in_scope?: string[]
  out_scope?: string[]
  requirements?: string[]
  risks?: string[]
  open_questions?: string[]
}

export interface BackendSprint {
  id: string
  project_id: string
  name: string
  goal?: string
  start_date: string
  end_date: string
  status: string
  story_id?: string | null
  member_ids?: string[]
  goals?: string[]
  goals_done?: number[]
  summary?: string
  why?: string
}

/** `GET /projects/:id/custom-statuses`. */
export interface BackendStatuses {
  defaults: { key: string; order: number; is_active: boolean }[]
  custom: { id: string; key: string; label: string; order: number; is_terminal: boolean; is_active: boolean }[]
}

const flip = <K extends string, V extends string>(m: Record<K, V>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<V, K>

const STATUS_IN: Record<string, string> = { to_do: 'todo', in_progress: 'prog', bug: 'todo' }
const STATUS_OUT: Record<string, string> = { todo: 'to_do', prog: 'in_progress' }
/** Backend status key → app status id; a project's custom keys pass through. */
export const statusIdFrom = (key: string) => STATUS_IN[key] ?? key
export const statusKeyFrom = (id: string) => STATUS_OUT[id] ?? id

const PRIO_OUT: Record<Priority, string> = { Critical: 'critical', Urgent: 'urgent', High: 'high', Medium: 'medium', Low: 'low' }
const PRIO_IN = flip(PRIO_OUT)
export const prioFrom = (p: string): Priority => PRIO_IN[p] ?? 'Medium'
export const prioTo = (p: Priority) => PRIO_OUT[p]

const TYPE_OUT: Record<TaskType, string> = { Bug: 'bug', Task: 'task', Story: 'story' }
const TYPE_IN: Record<string, TaskType> = { ...flip(TYPE_OUT), improvement: 'Story' }
export const typeFrom = (t: string): TaskType => TYPE_IN[t] ?? 'Task'
export const typeTo = (t: TaskType) => TYPE_OUT[t]

export const sprintStateFrom = (s: string): SprintState => (s === 'completed' ? 'done' : s === 'active' ? 'active' : 'planned')
export const sprintStateTo = (s: SprintState) => (s === 'done' ? 'completed' : s)

/** A legacy sprint shown under one epic has the id `<sprintId>~<epicId>`; the backend knows only the first part. */
export const realSprintId = (appId: string) => appId.split('~')[0]

const palette = (id: string) => hashOf(id) % 8
const doneMap = (xs: number[] = []): Record<number, boolean> => Object.fromEntries(xs.map(i => [i, true]))

export const epicFrom = (s: BackendStory): Epic => ({
  id: s.id,
  name: s.title,
  p: palette(s.id),
  desc: s.description ?? '',
  goal: s.goal ?? '',
  story: s.user_story ?? '',
  criteria: s.criteria ?? [],
  critDone: doneMap(s.criteria_done),
  target: s.target_date ?? '',
  inScope: s.in_scope ?? [],
  outScope: s.out_scope ?? [],
  reqs: s.requirements ?? [],
  risks: s.risks ?? [],
  questions: s.open_questions ?? [],
})

/** Tasks without a story live in their project's "No epic". */
export const noEpicFor = (projectId: string): Epic => ({ id: `none~${projectId}`, name: 'No epic', p: palette(projectId) })

/**
 * A sprint of an epic is one entry. A sprint made before sprints had an epic
 * is shown under every epic its tasks are in (or the project's "No epic" when
 * it has none), each entry with the id `<sprintId>~<epicId>`.
 */
export const sprintsFrom = (sp: BackendSprint, storyIdsOfItsTasks: string[], names: (id: string) => string): Sprint[] => {
  const base = {
    name: sp.name,
    start: sp.start_date,
    end: sp.end_date,
    members: (sp.member_ids ?? []).map(names).filter(Boolean),
    state: sprintStateFrom(sp.status),
    goal: sp.goal ?? '',
    summary: sp.summary ?? '',
    why: sp.why ?? '',
    goals: sp.goals ?? [],
    goalsDone: doneMap(sp.goals_done),
  }
  if (sp.story_id) return [{ id: sp.id, epic: sp.story_id, ...base }]
  const epics = [...new Set(storyIdsOfItsTasks)]
  return (epics.length ? epics : [`none~${sp.project_id}`]).map(epic => ({ id: `${sp.id}~${epic}`, epic, ...base }))
}

const leadOf = (t: BackendTask) => t.primary_assignee_id ?? t.assignee_ids[0] ?? null

export const taskFrom = (
  t: BackendTask,
  ctx: {
    key: string
    sprintIdFor: (t: BackendTask) => string | null
    epicIdFor: (t: BackendTask) => string
    names: (id: string) => string
    children: BackendTask[]
  },
): Task => {
  const lead = leadOf(t)
  const subs: Subtask[] = ctx.children.map(c => {
    const l = leadOf(c)
    return { t: c.title, done: c.status === 'done', sid: c.id, due: c.due_date ?? '', assignee: l ? ctx.names(l) : '', note: c.description ?? '' }
  })
  return {
    id: t.id,
    subKey: ctx.key,
    title: t.title,
    type: typeFrom(t.issue_type),
    status: statusIdFrom(t.status),
    prio: prioFrom(t.priority),
    due: t.due_date ?? '',
    start: t.start_date ?? '',
    assignee: lead ? ctx.names(lead) : '',
    assignees: t.assignee_ids.map(ctx.names).filter(Boolean),
    contribs: t.collaborator_ids.map(ctx.names).filter(Boolean),
    est: t.estimated_hours ? `${t.estimated_hours}h` : '',
    desc: t.description ?? '',
    atts: [],
    subs,
    deps: t.depends_on_task_ids ?? [],
    epic: ctx.epicIdFor(t),
    sprint: ctx.sprintIdFor(t),
    time: {},
    acts: [],
    ...(t.parent_task_id ? { parent: t.parent_task_id } : {}),
    ...(t.source === 'client' ? { clientBug: { reported: fmt(t.created_at.slice(0, 10)), chat: [] } } : {}),
  }
}

/**
 * The PATCH/POST body for the task fields in `patch`. Only the fields given
 * are sent; people go by name in the app and by id here (unknown names are
 * left out). Dependencies, subtasks and hours have their own routes.
 */
export const taskBody = (
  patch: Partial<Task>,
  ctx: { ids: (name: string) => string | undefined; realSprintId: (appId: string | null) => string | null; storyIdOf: (epicId: string) => string | null },
): Record<string, unknown> => {
  const toIds = (names: string[]) => names.map(ctx.ids).filter((x): x is string => !!x)
  const b: Record<string, unknown> = {}
  if (patch.title !== undefined) b.title = patch.title
  if (patch.type !== undefined) b.issue_type = typeTo(patch.type)
  if (patch.status !== undefined) b.status = statusKeyFrom(patch.status)
  if (patch.prio !== undefined) b.priority = prioTo(patch.prio)
  if (patch.due !== undefined) b.due_date = patch.due || null
  if (patch.start !== undefined) b.start_date = patch.start || null
  if (patch.est !== undefined) b.estimated_hours = parseFloat(patch.est) || 0
  if (patch.desc !== undefined) b.description = patch.desc
  const people = patch.assignees ?? (patch.assignee !== undefined ? (patch.assignee ? [patch.assignee] : []) : undefined)
  if (people) {
    b.assignee_ids = toIds(people)
    b.primary_assignee_id = (b.assignee_ids as string[])[0] ?? null
  }
  if (patch.contribs !== undefined) b.collaborator_ids = toIds(patch.contribs)
  if (patch.epic !== undefined) b.story_id = ctx.storyIdOf(patch.epic)
  if (patch.sprint !== undefined) b.sprint_id = ctx.realSprintId(patch.sprint)
  return b
}
