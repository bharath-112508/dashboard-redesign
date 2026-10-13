import { api } from './client'
import { allPages, liveProjects } from './companies'
import type { BackendProject } from './companyMappers'
import {
  epicFrom,
  noEpicFor,
  sprintsFrom,
  taskFrom,
  type BackendSprint,
  type BackendStatuses,
  type BackendStory,
  type BackendTask,
} from './boardMappers'
import type { Epic, Session, Sprint, Status, Task, TaskId, Workspace } from '../types'

/** Where each board item lives on the backend, kept for writes. */
export interface BoardIndex {
  projectOfEpic: Map<string, string>
  projectOfTask: Map<TaskId, string>
  /** The backend story of an app epic; null for a project's "No epic". */
  storyOfEpic: Map<string, string | null>
  /** Person name → user id, for writes that name people. */
  idOfName: Map<string, string>
}

export interface Board {
  workspace: Workspace
  tasks: Task[]
  index: BoardIndex
}

const DEFAULT_STATUSES: Status[] = [
  { id: 'todo', name: 'To do', p: 0 },
  { id: 'prog', name: 'In progress', p: 1 },
  { id: 'review', name: 'Review', p: 2 },
  { id: 'done', name: 'Done', p: 3 },
]

const emptyIndex = (): BoardIndex => ({ projectOfEpic: new Map(), projectOfTask: new Map(), storyOfEpic: new Map(), idOfName: new Map() })

/** The last board loaded, for writes (which project a ticket is in, which story an epic is). */
export let boardIndex: BoardIndex = emptyIndex()

type ProjectData = {
  project: BackendProject
  stories: BackendStory[]
  sprints: BackendSprint[]
  statuses: BackendStatuses
  members: { id: string; full_name: string }[]
  tasks: BackendTask[]
}

const readProject = async (project: BackendProject): Promise<ProjectData> => {
  const at = `/projects/${project.id}`
  const [stories, sprints, statuses, members, tasks] = await Promise.all([
    allPages<BackendStory>(`${at}/stories`),
    allPages<BackendSprint>(`${at}/sprints`),
    api.get<BackendStatuses>(`${at}/custom-statuses`),
    api.get<{ id: string; full_name: string }[]>(`${at}/members`),
    allPages<BackendTask>(`/tasks?project_id=${project.id}`),
  ])
  return { project, stories, sprints, statuses, members, tasks }
}

/**
 * Every epic, sprint and ticket the signed-in person may see, from the
 * projects the backend lists for them. Workspace and tasks come from the same
 * read, so they always agree.
 */
// ponytail: five requests per project and a full reload after every write; fine at Demo DB size,
// add one backend board endpoint (and refetch only what a command touched) before production size.
export const loadBoard = async (session: Session | null): Promise<Board> => {
  const index = emptyIndex()
  if (!session) return { workspace: { statuses: DEFAULT_STATUSES, epics: [], sprints: [], devopsLinks: {} }, tasks: [], index }
  const data = await Promise.all((await liveProjects()).map(readProject))

  // People are named in the app: names of every project's members.
  const nameOf = new Map<string, string>()
  for (const d of data) for (const m of d.members) nameOf.set(m.id, m.full_name)
  const names = (id: string) => nameOf.get(id) ?? ''
  for (const [id, name] of nameOf) index.idOfName.set(name, id)

  const statuses = [...DEFAULT_STATUSES]
  const epics: Epic[] = []
  const sprints: Sprint[] = []
  const tasks: Task[] = []
  for (const { project, stories, sprints: projectSprints, statuses: st, tasks: list } of data) {
    for (const c of [...st.custom].sort((a, b) => a.order - b.order))
      if (c.is_active && !statuses.some(s => s.id === c.key)) statuses.push({ id: c.key, name: c.label, p: c.order })

    const storyIds = new Set(stories.map(s => s.id))
    const none = noEpicFor(project.id)
    const epicIdFor = (t: BackendTask) => (t.story_id && storyIds.has(t.story_id) ? t.story_id : none.id)
    const sprintById = new Map(projectSprints.map(s => [s.id, s]))
    const sprintIdFor = (t: BackendTask) => {
      const sp = t.sprint_id ? sprintById.get(t.sprint_id) : undefined
      if (!sp) return null
      return sp.story_id ? sp.id : `${sp.id}~${epicIdFor(t)}`
    }

    const projectSprintList = projectSprints.flatMap(sp => sprintsFrom(sp, list.filter(t => t.sprint_id === sp.id).map(epicIdFor), names))
    const projectEpics = stories.map(epicFrom)
    if (list.some(t => epicIdFor(t) === none.id) || projectSprintList.some(s => s.epic === none.id)) projectEpics.push(none)
    for (const e of projectEpics) {
      index.projectOfEpic.set(e.id, project.id)
      index.storyOfEpic.set(e.id, e.id === none.id ? null : e.id)
    }
    epics.push(...projectEpics)
    sprints.push(...projectSprintList)

    const byNumber = (a: BackendTask, b: BackendTask) => (a.task_number ?? 0) - (b.task_number ?? 0)
    for (const t of list) {
      index.projectOfTask.set(t.id, project.id)
      tasks.push(
        taskFrom(t, {
          key: `${project.code ?? 'T'}-${t.task_number ?? '?'}`,
          sprintIdFor,
          epicIdFor,
          names,
          children: list.filter(c => c.parent_task_id === t.id).sort(byNumber),
        }),
      )
    }
  }
  boardIndex = index
  return { workspace: { statuses, epics, sprints, devopsLinks: {} }, tasks, index }
}

let inflight: Promise<Board> | null = null
/** One load per refetch round: the workspace and tasks queries ask at the same time. */
const shared = (session: Session | null) => (inflight ??= loadBoard(session).finally(() => (inflight = null)))

export const fetchWorkspace = async (session: Session | null) => (await shared(session)).workspace
export const fetchTasks = async (session: Session | null) => (await shared(session)).tasks
