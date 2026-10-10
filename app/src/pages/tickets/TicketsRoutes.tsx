import { Navigate, Route, Routes } from 'react-router'
import { teamPerson } from '../../lib/theme'
import { PageContext, type PageInfo } from '../../state/page'
import { UiProvider } from '../../state/ui'
import { PlanView } from '../clients/PlanView'
import { TimelineView } from '../clients/TimelineView'
import { TicketsLayout } from './TicketsLayout'
import { BoardView } from './BoardView'
import { ListView } from './ListView'
import { OverviewView } from './OverviewView'
import { BacklogView } from './BacklogView'
import { TimesheetView } from './TimesheetView'
import { FilesView } from './FilesView'

/** The team's side of the shared windows, with personal avatar colours. */
const TEAM_PAGE: PageInfo = { side: 'team', base: '/tickets', person: teamPerson }

/**
 * Entry point for the Tickets page (team side). It has its own board filters
 * and epic selection, separate from the Clients page.
 */
export function TicketsRoutes() {
  return (
    <UiProvider>
      <PageContext.Provider value={TEAM_PAGE}>
        <Routes>
          <Route element={<TicketsLayout />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="overview" element={<OverviewView />} />
            <Route path="board" element={<BoardView />} />
            <Route path="tasks" element={<ListView />} />
            <Route path="backlog" element={<BacklogView />} />
            <Route path="plan" element={<PlanView />} />
            <Route path="timeline" element={<TimelineView />} />
            <Route path="timesheet" element={<TimesheetView />} />
            <Route path="files" element={<FilesView />} />
            <Route path="*" element={<Navigate to="board" replace />} />
          </Route>
        </Routes>
      </PageContext.Provider>
    </UiProvider>
  )
}
