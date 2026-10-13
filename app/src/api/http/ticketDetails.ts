import { api } from './client'
import { allPages } from './companies'
import { boardIndex } from './board'
import { prioFrom, statusIdFrom, typeFrom } from './boardMappers'
import { fileSize } from '../../domain/tasks'
import { fmt } from '../../lib/dates'
import type { Activity, Attachment } from '../types'

type Person = { full_name?: string | null } | null | undefined
type BackendComment = { id: string; body: string; author?: Person; created_at: string }
type BackendActivity = { id?: string; activity_type: string; from_value?: unknown; to_value?: unknown; actor?: Person; created_at?: string }
type BackendAttachment = { id: string; file_name: string; file_size: number; created_at: string }

/** "just now", "5m ago", "3h ago", "2d ago", then the date: how the board writes times. */
export const ago = (iso: string, now = new Date()) => {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  return fmt(iso.slice(0, 10))
}

/** The calendar day of a timestamp where the person is, as YYYY-MM-DD. */
const localDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A history line for one activity row, as the mock writes them; null for rows the drawer does not list. */
export const historyLine = (r: Pick<BackendActivity, 'activity_type' | 'from_value' | 'to_value'>): string | null => {
  const to = r.to_value
  switch (r.activity_type) {
    case 'created':
      return 'created the task'
    case 'status_changed': {
      const id = statusIdFrom(str(to))
      return `moved it to ${boardIndex.statusNames.get(id) ?? id}`
    }
    case 'title_changed':
      return `renamed it to “${str(to)}”`
    case 'priority_changed':
      return `set priority to ${prioFrom(str(to))}`
    case 'due_date_changed':
      return to ? `set the due date to ${fmt(str(to))}` : 'removed the due date'
    case 'estimate_changed':
      return to ? `set the estimate to ${to}h` : 'removed the estimate'
    case 'issue_type_changed':
      return `changed the type to ${typeFrom(str(to))}`
    case 'assignee_changed':
      return 'changed the assignee'
    case 'collaborator_added':
      return 'added a contributor'
    case 'collaborator_removed':
      return 'removed a contributor'
    case 'sprint_changed':
      return to ? 'moved it to a sprint' : 'moved it to the backlog'
    case 'story_changed':
      return 'moved it to another epic'
    case 'rank_changed':
      return 'reordered it'
    case 'story_points_changed':
      return 'changed the story points'
    case 'labels_changed':
      return 'changed the labels'
    case 'dependency_added':
      return 'linked a blocker'
    case 'dependency_removed':
      return 'unlinked a blocker'
    case 'subtask_added':
      return 'added a subtask'
    case 'attachment_added':
      return 'added an attachment'
    case 'attachment_removed':
      return 'removed an attachment'
    case 'flag_added':
      return 'flagged it'
    case 'flag_removed':
      return 'removed the flag'
    default:
      // Comment events are shown as the comments themselves.
      return null
  }
}

export const isBackendId = (id: string) => /^[a-f0-9]{24}$/i.test(id)
const nameOf = (p: Person) => p?.full_name || 'Someone'

/**
 * The open ticket's comments, history and attachments. Comments and
 * attachments come oldest first, so every page is read; history comes newest
 * first and only its first page (100 rows) is read.
 */
// ponytail: history is capped at its newest 100 rows; page it if older lines are ever needed.
export const fetchTicketDetails = async (taskId: string, now = new Date()): Promise<{ acts: Activity[]; atts: Attachment[] }> => {
  // A draft or a ticket still being created has no backend id yet.
  if (!isBackendId(taskId)) return { acts: [], atts: [] }
  const at = `/tasks/${taskId}`
  const [comments, activity, files] = await Promise.all([
    allPages<BackendComment>(`${at}/comments`),
    api.get<BackendActivity[]>(`${at}/activity?limit=100`),
    allPages<BackendAttachment>(`${at}/attachments`),
  ])
  const dated: { at: string; act: Activity }[] = [
    ...comments.map(c => ({ at: c.created_at, act: { kind: 'comment' as const, who: nameOf(c.author), text: c.body, when: ago(c.created_at, now) } })),
    ...activity.flatMap(a => {
      const what = historyLine(a)
      return what && a.created_at ? [{ at: a.created_at, act: { kind: 'history' as const, who: nameOf(a.actor), what, when: ago(a.created_at, now) } }] : []
    }),
  ]
  return {
    acts: dated.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).map(d => d.act),
    atts: files.map(f => ({ id: f.id, name: f.file_name, size: fileSize(f.file_size), date: fmt(localDate(f.created_at)) })),
  }
}
