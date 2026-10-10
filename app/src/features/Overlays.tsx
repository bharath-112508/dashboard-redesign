import { useOverlay } from '../state/ui'
import { useIsClient } from '../state/access'
import { ticketIdFromParam } from '../domain/tasks'
import { TicketDrawer } from './ticket/TicketDrawer'
import { ConversationModal } from './conversation/ConversationModal'
import { RequestDrawer } from './requests/RequestDrawer'
import { ReportBugModal } from './bugs/ReportBugModal'
import { EpicFormModal } from './plan/EpicFormModal'
import { EpicDocModal } from './plan/EpicDocModal'
import { SprintFormModal } from './plan/SprintFormModal'
import { SprintViewModal } from './plan/SprintViewModal'

/** Renders whichever window the URL asks for (?ticket=12 or ?ticket=PMT-12, ?bug=17, ?report=1 …). */
export function Overlays() {
  const { get } = useOverlay()
  const num = (k: Parameters<typeof get>[0]) => {
    const v = get(k)
    return v != null && v !== '' && !isNaN(+v) ? +v : null
  }
  // ?ticket= takes a number or a key such as PMT-12 (My tickets links use the key).
  const ticket = ticketIdFromParam(get('ticket'))
  const bug = num('bug')
  const question = num('question')
  const request = num('request')
  const sprint = get('sprint')
  const epic = get('epic')
  const newSprint = get('newSprint')
  // Creating epics and sprints is the team's job, even when a client opens the link.
  const client = useIsClient()
  return (
    <>
      {ticket != null && <TicketDrawer id={ticket} />}
      {request != null && <RequestDrawer id={request} />}
      {(bug != null || question != null) && <ConversationModal bugId={bug ?? undefined} questionId={question ?? undefined} />}
      {epic && <EpicDocModal id={epic} />}
      {sprint && <SprintViewModal id={sprint} />}
      {get('newEpic') && !client && <EpicFormModal />}
      {newSprint && !client && <SprintFormModal key={newSprint} epicId={newSprint} />}
      {get('report') && <ReportBugModal />}
    </>
  )
}
