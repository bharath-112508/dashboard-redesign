import { useOverlay } from '../state/ui'
import { TicketDrawer } from './ticket/TicketDrawer'
import { ConversationModal } from './conversation/ConversationModal'
import { RequestDrawer } from './requests/RequestDrawer'
import { ReportBugModal } from './bugs/ReportBugModal'
import { EpicFormModal } from './plan/EpicFormModal'
import { EpicDocModal } from './plan/EpicDocModal'
import { SprintFormModal } from './plan/SprintFormModal'
import { SprintViewModal } from './plan/SprintViewModal'

/** Renders whichever window the URL asks for (?ticket=12, ?bug=17, ?report=1 …). */
export function Overlays() {
  const { get } = useOverlay()
  const num = (k: Parameters<typeof get>[0]) => {
    const v = get(k)
    return v != null && v !== '' && !isNaN(+v) ? +v : null
  }
  const ticket = num('ticket')
  const bug = num('bug')
  const question = num('question')
  const request = num('request')
  const sprint = get('sprint')
  const epic = get('epic')
  const newSprint = get('newSprint')
  return (
    <>
      {ticket != null && <TicketDrawer id={ticket} />}
      {request != null && <RequestDrawer id={request} />}
      {(bug != null || question != null) && <ConversationModal bugId={bug ?? undefined} questionId={question ?? undefined} />}
      {epic && <EpicDocModal id={epic} />}
      {sprint && <SprintViewModal id={sprint} />}
      {get('newEpic') && <EpicFormModal />}
      {newSprint && <SprintFormModal key={newSprint} epicId={newSprint} />}
      {get('report') && <ReportBugModal />}
    </>
  )
}
