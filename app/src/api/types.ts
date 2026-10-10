import type { DevopsDb } from './devops/types'

export type TaskType = 'Bug' | 'Task' | 'Story'
export type Priority = 'Critical' | 'Urgent' | 'High' | 'Medium' | 'Low'
export type ClientPriority = 'Low' | 'Medium' | 'High' | 'Critical'
export type SprintState = 'done' | 'active' | 'planned'

export interface Status {
  id: string
  name: string
  /** Palette index used for the status colour. */
  p: number
}

export interface Epic {
  id: string
  name: string
  p: number
  desc?: string
  goal?: string
  story?: string
  criteria?: string[]
  critDone?: Record<number, boolean>
  target?: string
  inScope?: string[]
  outScope?: string[]
  reqs?: string[]
  risks?: string[]
  questions?: string[]
}

export type EpicListField = 'inScope' | 'outScope' | 'reqs' | 'risks' | 'questions' | 'criteria'

export interface Sprint {
  id: string
  epic: string
  name: string
  start: string
  end: string
  members: string[]
  state: SprintState
  summary?: string
  goal?: string
  why?: string
  goals?: string[]
  goalsDone?: Record<number, boolean>
}

export interface Activity {
  kind: 'history' | 'comment'
  who: string
  what?: string
  text?: string
  when: string
}

export interface Attachment {
  name: string
  size: string
  date: string
  /** Data URL for small uploads; empty when the file was too large to keep. */
  url?: string
}

export interface ChatFile {
  name: string
  size: string
  url: string
  img: boolean
}

export interface ChatMessage {
  who: string
  side: 'client' | 'team'
  text: string
  when: string
  files: ChatFile[]
}

export interface Subtask {
  t: string
  done: boolean
  /** Id of the full subtask record once it has been opened. */
  sid?: number
  due?: string
  assignee?: string
  note?: string
}

export interface ClientBugInfo {
  reported: string
  chat: ChatMessage[]
}

export interface Task {
  id: number
  title: string
  type: TaskType
  status: string
  prio: Priority
  due: string
  assignee: string
  assignees?: string[]
  contribs: string[]
  est: string
  desc: string
  atts: Attachment[]
  subs: Subtask[]
  deps: number[]
  epic: string
  sprint: string | null
  start: string
  time: Record<string, number>
  acts: Activity[]
  /** Set on subtask records: id of the parent task. */
  parent?: number
  subKey?: string
  /** A ticket created from the plan view that has no title yet. */
  isNew?: boolean
  /** Present when the client reported this bug from the Clients page. */
  clientBug?: ClientBugInfo
}

export interface TimeEntry {
  id: number
  date: string
  user: string
  type: string
  task: number
  notes: string
  bill: number
  non: number
}

export interface Question {
  id: number
  by: string
  title: string
  text: string
  when: string
  task: number | null
  answer: string
  answeredWhen?: string
  comments?: ChatMessage[]
  photos?: ChatFile[]
  solved?: boolean
  qtype?: string
  qprio?: string
  fromDevops?: boolean
  /** DevOps project key (e.g. OPS-101) for questions raised from the DevOps board. */
  project?: string
  sprint?: string | null
  /** How many client messages the team has already seen (Tickets page unread badge). */
  seenT?: number
}

export type RequestStatus = 'Open' | 'In progress' | 'Done'

export interface RequestComment {
  by: string
  text: string
  when: string
  side: 'tickets' | 'devops'
}

export interface DevopsRequest {
  id: number
  key: string
  pname: string
  rkey: string
  type: string
  prio: Priority
  to: string
  text: string
  by: string
  when: string
  raised: string
  status: RequestStatus
  comments: RequestComment[]
  history?: { by: string; text: string; when: string }[]
  desc?: string
  due?: string
  start?: string
  est?: string
  logs?: { h: number; by: string; when: string; date?: string; notes?: string }[]
  /** How many DevOps replies / which status the Tickets side has already seen (for unread badges). */
  seenT?: number
  statusSeen?: string
}

export interface Workspace {
  statuses: Status[]
  epics: Epic[]
  sprints: Sprint[]
  /** Which DevOps project (key in the devops resource) each epic is linked to. */
  devopsLinks: Record<string, string>
}

export interface Db {
  version: number
  workspace: Workspace
  tasks: Task[]
  entries: TimeEntry[]
  questions: Question[]
  requests: DevopsRequest[]
  devops: DevopsDb
}
