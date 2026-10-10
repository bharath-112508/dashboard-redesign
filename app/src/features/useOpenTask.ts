import { useCallback } from 'react'
import { useSendAsync, useTasks, useWorkspace } from '../api/queries'
import type { Task } from '../api/types'
import { TODAY } from '../lib/dates'
import { ME } from '../lib/theme'
import { activeSprint, nextTaskId } from '../domain/tasks'
import { useOverlay } from '../state/ui'
import { usePage } from '../state/page'

/**
 * Opens a ticket. On the Clients page, client-reported bugs open in the bug
 * chat; the team always gets the ticket drawer (with a "Client chat" tab).
 */
export const useOpenTask = () => {
  const overlay = useOverlay()
  const { side } = usePage()
  return useCallback(
    (t: Pick<Task, 'id' | 'clientBug'>) =>
      t.clientBug && side === 'client' ? overlay.open('bug', t.id) : overlay.open('ticket', t.id),
    [overlay, side],
  )
}

/**
 * Creates an empty ticket and opens it so the title can be typed straight away.
 * The server has the final say on the id: another tab may have taken the one
 * suggested here. If it does, the window moves to the id the server gave.
 */
export const useCreateTicket = () => {
  const tasks = useTasks().data ?? []
  const ws = useWorkspace().data
  const send = useSendAsync()
  const overlay = useOverlay()
  /** Whether the ticket window still shows `id` (the user may have moved on). */
  const showing = (id: number) => new URLSearchParams(window.location.search).get('ticket') === String(id)
  /** `top` adds the ticket at the top of its column instead of the bottom. */
  return async (p: { epic: string; sprint?: string | null; status?: string; type?: Task['type']; top?: boolean }) => {
    if (!ws) return
    const id = nextTaskId(tasks)
    const sprint = p.sprint !== undefined ? p.sprint : activeSprint(ws.sprints, p.epic)?.id ?? null
    overlay.open('ticket', id)
    let saved: { id?: number }
    try {
      saved = await send({
        type: p.top ? 'tickets.task.createTop' : 'task.create',
        task: {
          id,
          isNew: true,
          title: '',
          type: p.type || 'Task',
          status: p.status || ws.statuses[0].id,
          prio: 'Medium',
          due: '',
          assignee: '',
          assignees: [],
          contribs: [],
          est: '',
          desc: '',
          atts: [],
          subs: [],
          deps: [],
          epic: p.epic,
          sprint,
          start: TODAY,
          time: {},
          acts: [{ kind: 'history', who: ME, what: 'created the task', when: 'just now' }],
        },
      })
    } catch {
      // The optimistic update was rolled back, so the window has nothing to show.
      if (showing(id)) overlay.close('ticket')
      return
    }
    if (saved.id !== undefined && saved.id !== id && showing(id)) overlay.open('ticket', saved.id, { replace: true })
  }
}
