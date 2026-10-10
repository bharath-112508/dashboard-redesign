import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { ClientsLayout } from './pages/clients/ClientsLayout'
import { BoardView } from './pages/clients/BoardView'
import { PlanView } from './pages/clients/PlanView'
import { TimelineView } from './pages/clients/TimelineView'
import { TicketsRoutes } from './pages/tickets/TicketsRoutes'
import { DevopsRoutes } from './pages/devops/DevopsRoutes'
import { ComingSoon } from './pages/shell/ComingSoon'
import { Shell } from './pages/shell/Shell'
import { LoginPage } from './pages/login/LoginPage'
import { UsersPage } from './pages/users/UsersPage'
import { ProfilePage } from './pages/users/ProfilePage'
import { EmployeeTimesheetsPage } from './pages/employee-timesheets/EmployeeTimesheetsPage'
import { PAGE_PATH, isPageName } from './api/session/pages'
import { UiProvider } from './state/ui'

/**
 * Prototype hash links ("#Dashboard?x=1") open the page they name. Other
 * hashes are ignored.
 */
function HashRedirect({ children }: { children: ReactNode }) {
  const { hash, search } = useLocation()
  const [name, query] = decodeURIComponent(hash.slice(1)).split('?')
  if (name && isPageName(name)) {
    return <Navigate to={{ pathname: PAGE_PATH[name], search: query ? '?' + query : search }} replace />
  }
  return children
}

export function App() {
  return (
    <UiProvider>
      <HashRedirect>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<ComingSoon page="Dashboard" />} />
            <Route path="companies" element={<ComingSoon page="Companies" />} />
            <Route path="projects" element={<ComingSoon page="Projects" />} />
            <Route path="my-tickets" element={<ComingSoon page="My tickets" />} />
            <Route path="timesheet" element={<ComingSoon page="Timesheet" />} />
            <Route path="employee-timesheets">
              <Route index element={<EmployeeTimesheetsPage />} />
              <Route path=":id" element={<ProfilePage base="employee-timesheets" />} />
            </Route>
            <Route path="users">
              <Route index element={<UsersPage />} />
              <Route path=":id" element={<ProfilePage base="users" />} />
            </Route>
            <Route path="clients">
              <Route index element={<ComingSoon page="Your projects" />} />
              <Route element={<ClientsLayout />}>
                <Route path="board" element={<BoardView />} />
                <Route path="plan" element={<PlanView />} />
                <Route path="timeline" element={<TimelineView />} />
                <Route path="*" element={<Navigate to="board" replace />} />
              </Route>
            </Route>
            <Route path="devops/*" element={<DevopsRoutes />} />
            <Route path="tickets/*" element={<TicketsRoutes />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </HashRedirect>
    </UiProvider>
  )
}
