import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { onSignedOut } from './api/http/client'
import { clearSession, readSession } from './api/session/store'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})

// When the backend refuses to refresh the sign-in (expired, or signed out elsewhere), sign out here too; the guard then shows /login.
onSignedOut(() => {
  // Several failing calls can report sign-out at once; act once.
  if (!readSession()) return
  clearSession()
  queryClient.clear()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
