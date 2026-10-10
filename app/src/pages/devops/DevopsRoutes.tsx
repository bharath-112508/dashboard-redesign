import { Navigate, Route, Routes } from 'react-router'
import { DevopsProvider } from '../../features/devops/ctx'
import { DevopsPage } from './DevopsPage'

/** Entry point for the DevOps board: /devops/board and /devops/list, with windows opened by URL parameters. */
export function DevopsRoutes() {
  return (
    <DevopsProvider>
      <Routes>
        <Route index element={<Navigate to="board" replace />} />
        <Route path=":view" element={<DevopsPage />} />
      </Routes>
    </DevopsProvider>
  )
}
