import { ApiError, api } from './client'
import { entryBody } from './timesheetMappers'
import { allPages, liveProjects } from './companies'
import type { BackendProject } from './companyMappers'
import {
  epicFrom,
  noEpicFor,
  realSprintId,
  sprintsFrom,
  taskBody,
  taskFrom,
  type BackendSprint,
  type BackendStatuses,
  type BackendStory,
  type BackendTask,
} from './boardMappers'
import type { Command } from '../commands'
import type { Attachment, Epic, Session, Sprint, Status, Subtask, Task, TaskId, Workspace } from '../types'

/** Where each board item lives on the backend, kept for writes. */
export interface BoardIndex {
  projectOfEpic: Map<string, string>
  projectOfTask: Map<TaskId, string>
  /** The backend story of an app epic; null for a project's "No epic". */
  storyOfEpic: Map<string, string | null>
  /** Person name → user id, for writes that name people. */
  idOfName: Map<string, string>
  /** The tickets as loaded, to tell what a write changes (subtasks, blockers). */
  tasks: Map<TaskId, Task>
  /** Each real sprint's member ids, for adding members. */
  sprintMemberIds: Map<string, string[]>
  /** Each ticket's collaborator ids as stored, so people the board cannot name are kept. */
  collaboratorIds: Map<TaskId, string[]>
  /** Status id → its name, for history lines. */
  statusNames: Map<string, string>
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

const emptyIndex = (): BoardIndex => ({
  projectOfEpic: new Map(),
  projectOfTask: new Map(),
  storyOfEpic: new Map(),
  idOfName: new Map(),
  tasks: new Map(),
  sprintMemberIds: new Map(),
  collaboratorIds: new Map(),
  statusNames: new Map(),
})

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
  noteWho(session?.personId ?? '')
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
    for (const sp of projectSprints) index.sprintMemberIds.set(sp.id, sp.member_ids ?? [])

    const byNumber = (a: BackendTask, b: BackendTask) => (a.task_number ?? 0) - (b.task_number ?? 0)
    for (const t of list) {
      index.projectOfTask.set(t.id, project.id)
      index.collaboratorIds.set(t.id, t.collaborator_ids)
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
  for (const t of tasks) index.tasks.set(t.id, t)
  for (const s of statuses) index.statusNames.set(s.id, s.name)
  boardIndex = index
  return { workspace: { statuses, epics, sprints, devopsLinks: {} }, tasks, index }
}

let inflight: { who: string; board: Promise<Board> } | null = null
let lastWho: string | null = null
/** One load per refetch round (the workspace and tasks queries ask at the same time), never shared between people. */
/** Someone else signed in: nothing of the previous person's drafts or ids carries over. */
const noteWho = (who: string) => {
  if (who === lastWho) return
  lastWho = who
  drafts.clear()
  aliases.clear()
  creating.clear()
}
const shared = (session: Session | null) => {
  const who = session?.personId ?? ''
  noteWho(who)
  if (inflight?.who !== who) {
    const board = loadBoard(session).finally(() => {
      if (inflight?.board === board) inflight = null
    })
    inflight = { who, board }
  }
  return inflight.board
}

export const fetchWorkspace = async (session: Session | null) => (await shared(session)).workspace
export const fetchTasks = async (session: Session | null) => {
  const { tasks } = await shared(session)
  return session ? [...tasks, ...drafts.values()] : tasks
}

// ─── Writes ──────────────────────────────────────────────────────────────

const BOARD_COMMANDS = new Set([
  'task.create',
  'tickets.task.createTop',
  'task.update',
  'task.delete',
  'task.comment',
  'bug.message',
  'sprint.create',
  'sprint.update',
  'sprint.addMembers',
  'epic.create',
  'epic.update',
])

type BoardCommand = Extract<
  Command,
  {
    type:
      | 'task.create'
      | 'tickets.task.createTop'
      | 'task.update'
      | 'task.delete'
      | 'task.comment'
      | 'bug.message'
      | 'sprint.create'
      | 'sprint.update'
      | 'sprint.addMembers'
      | 'epic.create'
      | 'epic.update'
      | 'batch'
  }
>

/** Ticket, epic and sprint commands, and batches made only of them, go to the backend. */
export const isBoardApiCommand = (cmd: { type: string; cmds?: { type: string }[] }): cmd is BoardCommand =>
  cmd.type === 'batch' ? !!cmd.cmds?.length && cmd.cmds.every(isBoardApiCommand) : BOARD_COMMANDS.has(cmd.type)

const refuse = (message: string) => new ApiError(403, 'NOT_AVAILABLE', message)

/** A person's user id; someone the project does not have is refused rather than silently dropped. */
const idOf = (name: string) => {
  const id = boardIndex.idOfName.get(name)
  if (!id) throw refuse(`${name} is not on this project.`)
  return id
}
const idsOf = (names: string[]) => names.filter(Boolean).map(idOf)
/** Stored ids the board shows no name for: kept when a list of people is written back. */
const unnamed = (ids: string[] = []) => {
  const known = new Set(boardIndex.idOfName.values())
  return ids.filter(id => !known.has(id))
}
const bodyCtx = {
  ids: idOf,
  realSprintId: (id: string | null) => (id ? realSprintId(id) : null),
  storyIdOf: (epic: string) => boardIndex.storyOfEpic.get(epic) ?? (epic.startsWith('none~') ? null : epic),
}
const projectOfEpic = (epic: string) => boardIndex.projectOfEpic.get(epic) ?? (epic.startsWith('none~') ? epic.slice(5) : undefined)
const firstProject = () => boardIndex.projectOfEpic.values().next().value as string | undefined

/**
 * A ticket made in the app has a temporary id until the backend answers. An
 * edit sent meanwhile waits for that answer and goes to the real ticket.
 */
const creating = new Map<TaskId, Promise<string>>()
const realTaskId = async (id: TaskId) => (await creating.get(id)) ?? aliases.get(id) ?? id

/**
 * "+ Create ticket" opens an empty ticket that is removed if it is left without
 * a title. The backend needs a title, so until it has one the ticket is a
 * draft kept here (and shown with the board's tickets); the title creates it.
 */
const drafts = new Map<TaskId, Task & { top?: boolean }>()
/** A draft's id → the backend id it was created under, so its open window can follow. */
const aliases = new Map<TaskId, string>()
export const ticketAlias = (id: TaskId) => aliases.get(id)

const createTask = async (task: Task, top: boolean): Promise<string | undefined> => {
  if (task.isNew && !task.title.trim()) {
    drafts.set(task.id, { ...task, top })
    return undefined
  }
  const project = (task.parent && boardIndex.projectOfTask.get(task.parent)) || projectOfEpic(task.epic) || firstProject()
  if (!project) throw refuse('There is no project to add this ticket to.')
  const pending = (async () => {
    // A client's bug goes through the report route, the one write clients have.
    if (task.clientBug) {
      const prio = task.prio === 'Low' ? 'low' : task.prio === 'Medium' ? 'medium' : 'high'
      const { id } = await api.post<{ id: string }>('/tasks/report', { project_id: project, kind: 'issue', title: task.title, description: task.desc, priority: prio })
      return id
    }
    const { id } = await api.post<{ id: string }>('/tasks', {
      project_id: project,
      ...taskBody(task, bodyCtx),
      ...(task.parent ? { parent_task_id: await realTaskId(task.parent) } : {}),
    })
    // Only managers and the assignee may rank: for anyone else the ticket stays where the backend put it.
    if (top) await api.post(`/tasks/${id}/rank`, {}).catch(err => {
      if (!(err instanceof ApiError && err.status === 403)) throw err
    })
    return id
  })()
  creating.set(task.id, pending)
  try {
    const id = await pending
    // Writes before the next reload (a subtask, a blocker) need to know the new ticket.
    boardIndex.projectOfTask.set(id, project)
    boardIndex.tasks.set(id, { ...task, id, subs: [], deps: [] })
    return id
  } finally {
    // Kept briefly so edits queued behind the create still find it.
    setTimeout(() => {
      if (creating.get(task.id) === pending) creating.delete(task.id)
    }, 60_000)
  }
}

const subBody = (s: Subtask): Record<string, unknown> => ({
  ...(s.due ? { due_date: s.due } : {}),
  ...(s.assignee ? { assignee_ids: idsOf([s.assignee]) } : {}),
  ...(s.note ? { description: s.note } : {}),
})

/** Subtask lines are the backend's linked tasks: new lines are created, changed ones patched, removed ones deleted. */
const saveSubs = async (parentId: string, before: Subtask[], after: Subtask[]): Promise<Subtask[]> => {
  const old = new Map(before.filter(s => s.sid).map(s => [s.sid as string, s]))
  const project = boardIndex.projectOfTask.get(parentId)
  const saved: Subtask[] = []
  // A line saved by an earlier write but not reloaded yet has no sid in the page: find it by title.
  const claimed = new Set(after.map(s => s.sid).filter(Boolean))
  const known = (s: Subtask) => [...old.values()].find(o => o.t === s.t && !claimed.has(o.sid) && claimed.add(o.sid))?.sid
  for (const s of after) {
    const sid = s.sid ? await realTaskId(s.sid) : known(s)
    const was = sid ? old.get(sid) : undefined
    if (sid && was) {
      const b: Record<string, unknown> = {}
      if (s.t !== was.t) b.title = s.t
      if (s.done !== was.done) b.status = s.done ? 'done' : 'to_do'
      if ((s.due ?? '') !== (was.due ?? '')) b.due_date = s.due || null
      if ((s.assignee ?? '') !== (was.assignee ?? '')) {
        b.assignee_ids = s.assignee ? idsOf([s.assignee]) : []
        b.primary_assignee_id = (b.assignee_ids as string[])[0] ?? null
      }
      if ((s.note ?? '') !== (was.note ?? '')) b.description = s.note ?? ''
      if (Object.keys(b).length) await api.patch(`/tasks/${sid}`, b)
      old.delete(sid)
      saved.push({ ...s, sid })
    } else if (!sid) {
      const { id } = await api.post<{ id: string }>('/tasks', { project_id: project, parent_task_id: parentId, title: s.t, status: s.done ? 'done' : 'to_do', ...subBody(s) })
      saved.push({ ...s, sid: id })
    } else saved.push({ ...s, sid }) // just created (the drawer opened it): nothing to do
  }
  for (const sid of old.keys()) await api.delete(`/tasks/${sid}`)
  return saved
}

/** Files picked in the drawer, waiting for the write that uploads them. */
const pickedFiles = new Map<string, File>()
let fileCount = 0
/** Keeps a picked file for upload and returns the reference the attachment carries. */
export const attachFile = (file: File) => {
  const ref = `file-${++fileCount}`
  pickedFiles.set(ref, file)
  return ref
}

type UploadTicket = { upload_url: string; blob_container: string; blob_key: string; required_headers: Record<string, string> }

/** New attachments are uploaded: a signed URL from the backend, the file straight to storage, then finalize. */
const saveAtts = async (id: string, atts: Attachment[]) => {
  for (const a of atts) {
    // Taken out before uploading, so a later edit that still lists it cannot upload it again.
    const file = a.fileRef ? pickedFiles.get(a.fileRef) : undefined
    if (!file) continue
    pickedFiles.delete(a.fileRef as string)
    const meta = { file_name: file.name, file_size: file.size, mime_type: file.type || 'application/octet-stream' }
    const t = await api.post<UploadTicket>(`/tasks/${id}/attachments/upload-url`, meta)
    // A network or storage (CORS) failure reads the same as a refused upload.
    const res = await fetch(t.upload_url, { method: 'PUT', headers: t.required_headers, body: file }).catch(() => null)
    if (!res?.ok) throw refuse('The file could not be uploaded. Try again.')
    await api.post(`/tasks/${id}/attachments/finalize`, { blob_container: t.blob_container, blob_key: t.blob_key, ...meta })
  }
}

/**
 * A ticket's "Log time" adds hours (the drawer keys them by its own date).
 * What was added becomes one billable time entry on the ticket, dated today,
 * for the signed-in person (the backend logs as the caller).
 */
const saveTicketHours = async (id: string, was: Task | undefined, time: Record<string, number>, today: string) => {
  const before = was?.time ?? {}
  const added = Object.entries(time).reduce((sum, [date, h]) => sum + Math.max(0, h - (before[date] ?? 0)), 0)
  if (added <= 0) return
  const entry = { id: '', date: today, userId: '', user: '', type: 'General', task: id, notes: '', bill: added, non: 0 }
  await api.post('/timesheets', entryBody(entry, { projectId: () => null, projectOfTask: t => boardIndex.projectOfTask.get(t) ?? null, taskTitle: t => boardIndex.tasks.get(t)?.title ?? '' }))
}

const saveDeps = async (id: string, before: TaskId[], after: TaskId[]) => {
  for (const d of after) if (!before.includes(d)) await api.post(`/tasks/${id}/dependencies`, { depends_on_task_id: await realTaskId(d) })
  for (const d of before) if (!after.includes(d)) await api.delete(`/tasks/${id}/dependencies/${d}`)
}

const updateTask = async (appId: TaskId, patch: Partial<Task>, today: string) => {
  const draft = drafts.get(appId)
  if (draft) {
    const { top, ...next } = { ...draft, ...patch }
    if (!next.title.trim()) return void drafts.set(appId, { ...next, top })
    drafts.delete(appId)
    const id = await createTask({ ...next, isNew: false }, !!top)
    if (id) aliases.set(appId, id)
    // Files dropped on the draft go up now that the ticket exists.
    if (id && next.atts.length) await saveAtts(id, next.atts)
    return
  }
  const id = await realTaskId(appId)
  const was = boardIndex.tasks.get(id)
  const body = taskBody(patch, bodyCtx)
  if (body.collaborator_ids) body.collaborator_ids = [...(body.collaborator_ids as string[]), ...unnamed(boardIndex.collaboratorIds.get(id))]
  // Blockers first: their routes are managers-only, so a refused change leaves the ticket as it was.
  if (patch.deps) await saveDeps(id, was?.deps ?? [], patch.deps)
  if (Object.keys(body).length) await api.patch(`/tasks/${id}`, body)
  const subs = patch.subs ? await saveSubs(id, was?.subs ?? [], patch.subs) : undefined
  if (patch.atts) await saveAtts(id, patch.atts)
  if (patch.time) await saveTicketHours(id, was, patch.time, today)
  // What is saved now is the "before" of the next write, until the board reloads.
  if (was) boardIndex.tasks.set(id, { ...was, ...patch, ...(subs ? { subs } : {}) })
}

const doneIndexes = (m: Record<number, boolean> = {}) =>
  Object.entries(m)
    .filter(([, v]) => v)
    .map(([k]) => +k)

const sprintBody = (p: Partial<Sprint>): Record<string, unknown> => {
  const b: Record<string, unknown> = {}
  if (p.name !== undefined) b.name = p.name
  if (p.start !== undefined) b.start_date = p.start
  if (p.end !== undefined) b.end_date = p.end
  if (p.goal !== undefined) b.goal = p.goal
  if (p.epic !== undefined) b.story_id = bodyCtx.storyIdOf(p.epic)
  if (p.members !== undefined) b.member_ids = idsOf(p.members)
  if (p.goals !== undefined) b.goals = p.goals
  if (p.goalsDone !== undefined) b.goals_done = doneIndexes(p.goalsDone)
  if (p.summary !== undefined) b.summary = p.summary
  if (p.why !== undefined) b.why = p.why
  return b
}

const updateSprint = async (appId: string, patch: Partial<Sprint>) => {
  const id = realSprintId(appId)
  const { state, ...rest } = patch
  if (state === 'active') await api.post(`/sprints/${id}/start`, {})
  if (state === 'done') await api.post(`/sprints/${id}/complete`, { move_unfinished_to: 'backlog' })
  const body: Record<string, unknown> = { ...sprintBody(rest), ...(state === 'planned' ? { status: 'planned' } : {}) }
  if (body.member_ids) body.member_ids = [...(body.member_ids as string[]), ...unnamed(boardIndex.sprintMemberIds.get(id))]
  if (Object.keys(body).length) await api.patch(`/sprints/${id}`, body)
}

const epicBody = (p: Partial<Epic>): Record<string, unknown> => {
  const b: Record<string, unknown> = {}
  if (p.name !== undefined) b.title = p.name
  if (p.desc !== undefined) b.description = p.desc
  if (p.goal !== undefined) b.goal = p.goal
  if (p.story !== undefined) b.user_story = p.story
  if (p.criteria !== undefined) b.criteria = p.criteria
  if (p.critDone !== undefined) b.criteria_done = doneIndexes(p.critDone)
  if (p.target !== undefined) b.target_date = p.target || null
  if (p.inScope !== undefined) b.in_scope = p.inScope
  if (p.outScope !== undefined) b.out_scope = p.outScope
  if (p.reqs !== undefined) b.requirements = p.reqs
  if (p.risks !== undefined) b.risks = p.risks
  if (p.questions !== undefined) b.open_questions = p.questions
  return b
}

/** Sends one board command to the backend. Creates resolve with the backend id. */
// ponytail: one queue for all board writes; writes are small, so order beats parallelism here.
let queue: Promise<unknown> = Promise.resolve()
/** Board writes go one at a time, in order, so each one sees what the previous one saved. */
export const sendBoardCommand = (cmd: BoardCommand, today: string): Promise<{ id?: string }> => {
  const run = queue.then(() => sendOne(cmd, today))
  queue = run.catch(() => undefined)
  return run
}

const sendOne = async (cmd: BoardCommand, today: string): Promise<{ id?: string }> => {
  switch (cmd.type) {
    case 'task.create':
      return { id: await createTask(cmd.task, !!cmd.top) }
    case 'tickets.task.createTop':
      return { id: await createTask(cmd.task, true) }
    case 'task.update':
      await updateTask(cmd.id, cmd.patch, today)
      return {}
    case 'task.delete':
      if (drafts.delete(cmd.id)) return {}
      await api.delete(`/tasks/${await realTaskId(cmd.id)}`)
      return {}
    case 'task.comment':
      await api.post(`/tasks/${await realTaskId(cmd.id)}/comments`, { body: cmd.text })
      return {}
    // A client bug's chat is its comments (the backend lets clients comment on their own bugs).
    case 'bug.message':
      // ponytail: comments carry text only; files in the chat need attachment uploads wired in here.
      if (cmd.message.files?.length) throw refuse("Files can't be sent in this chat yet. Add them to the bug as attachments.")
      await api.post(`/tasks/${await realTaskId(cmd.id)}/comments`, { body: cmd.message.text })
      return {}
    case 'sprint.create': {
      const { sprint } = cmd
      const project = projectOfEpic(sprint.epic)
      if (!project) throw refuse('There is no project for this sprint.')
      const story = bodyCtx.storyIdOf(sprint.epic)
      const { id } = await api.post<{ id: string }>(`/projects/${project}/sprints`, {
        name: sprint.name,
        start_date: sprint.start,
        end_date: sprint.end,
        goal: sprint.goal ?? '',
        ...(story ? { story_id: story } : {}),
        member_ids: idsOf(sprint.members),
        ...(sprint.goals ? { goals: sprint.goals } : {}),
      })
      return { id }
    }
    case 'sprint.update':
      await updateSprint(cmd.id, cmd.patch)
      return {}
    case 'sprint.addMembers': {
      const id = realSprintId(cmd.id)
      const member_ids = [...new Set([...(boardIndex.sprintMemberIds.get(id) ?? []), ...idsOf(cmd.names)])]
      await api.patch(`/sprints/${id}`, { member_ids })
      return {}
    }
    case 'epic.create': {
      const project = cmd.projectId ?? firstProject()
      if (!project) throw refuse('There is no project to add this epic to.')
      const { id: _tmp, p: _p, ...doc } = cmd.epic
      const { id } = await api.post<{ id: string }>(`/projects/${project}/stories`, epicBody(doc))
      return { id }
    }
    case 'epic.update':
      if (cmd.id.startsWith('none~')) throw refuse('"No epic" holds the tickets without an epic; it cannot be edited.')
      await api.patch(`/stories/${cmd.id}`, epicBody(cmd.patch))
      return {}
    case 'batch': {
      let last: { id?: string } = {}
      for (const c of cmd.cmds) last = await sendOne(c as BoardCommand, today)
      return last
    }
  }
}
