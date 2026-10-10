import { Navigate, Outlet, Route, Routes } from 'react-router'
import { useLiveSync } from './api/queries'
import { AppHeader } from './components/AppHeader'
import { ClientsLayout } from './pages/clients/ClientsLayout'
import { BoardView } from './pages/clients/BoardView'
import { PlanView } from './pages/clients/PlanView'
import { TimelineView } from './pages/clients/TimelineView'
import { TicketsRoutes } from './pages/tickets/TicketsRoutes'
import { DevopsRoutes } from './pages/devops/DevopsRoutes'
import { UiProvider } from './state/ui'

function Shell() {
  useLiveSync()
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <AppHeader />
      <Outlet />
    </div>
  )
}

export function App() {
  return (
    <UiProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/clients/board" replace />} />
          <Route path="clients" element={<ClientsLayout />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="board" element={<BoardView />} />
            <Route path="plan" element={<PlanView />} />
            <Route path="timeline" element={<TimelineView />} />
          </Route>
          <Route path="devops/*" element={<DevopsRoutes />} />
          <Route path="tickets/*" element={<TicketsRoutes />} />
          <Route path="*" element={<Navigate to="/clients/board" replace />} />
        </Route>
      </Routes>
    </UiProvider>
  )
}
