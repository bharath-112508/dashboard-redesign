import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { ClientsLayout } from './pages/clients/ClientsLayout'
import { PortalHome } from './pages/clients/portal/PortalHome'
import { BoardView } from './pages/clients/BoardView'
import { PlanView } from './pages/clients/PlanView'
import { TimelineView } from './pages/clients/TimelineView'
import { LiveAppPage } from './features/invoice-match/LiveAppPage'
import { TicketsRoutes } from './pages/tickets/TicketsRoutes'
import { DevopsRoutes } from './pages/devops/DevopsRoutes'
import { MyTicketsPage } from './pages/my-tickets/MyTicketsPage'
import { TimesheetPage } from './pages/timesheet/TimesheetPage'
import { DashboardPage } from './pages/dashboard/DashboardPage'
import { CompaniesPage } from './pages/companies/CompaniesPage'
import { CompanyDetailPage } from './pages/companies/CompanyDetailPage'
import { ProjectsPage } from './pages/projects/ProjectsPage'
import { Shell } from './pages/shell/Shell'
import { LoginPage } from './pages/login/LoginPage'
import { ForgotPasswordPage, ResetPasswordPage } from './pages/login/PasswordPages'
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
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="companies">
              <Route index element={<CompaniesPage />} />
              <Route path=":id" element={<CompanyDetailPage />} />
            </Route>
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="my-tickets" element={<MyTicketsPage />} />
            <Route path="timesheet" element={<TimesheetPage />} />
            <Route path="employee-timesheets">
              <Route index element={<EmployeeTimesheetsPage />} />
              <Route path=":id" element={<ProfilePage base="employee-timesheets" />} />
            </Route>
            <Route path="users">
              <Route index element={<UsersPage />} />
              <Route path=":id" element={<ProfilePage base="users" />} />
            </Route>

            <Route path="clients">
              <Route index element={<PortalHome />} />
              <Route path="live/invoicematch/*" element={<LiveAppPage />} />
              <Route element={<ClientsLayout />}>
                <Route path="board" element={<BoardView />} />
                <Route path="plan" element={<PlanView />} />
                <Route path="timeline" element={<TimelineView />} />
                <Route path="*" element={<Navigate to="/clients/board" replace />} />
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
