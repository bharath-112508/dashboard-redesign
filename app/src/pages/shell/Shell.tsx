import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveSync, useCompanies } from '../../api/queries'
import { findPerson, usePeople } from '../../api/people/directory'
import { canAccess, isClientRole, ROLE_LABEL } from '../../api/session/access'
import { PAGE_PATH, pageOfPath, type PageName } from '../../api/session/pages'
import { clearSession, useSession } from '../../api/session/store'
import { apiSignOut } from '../../api/http/auth'
import { apiMode } from '../../api/http/config'
import type { Session } from '../../api/types'
import { HEADER_SLOT_ID } from '../../components/HeaderSlot'
import { logoFor } from '../../lib/media'
import { useToast, ToastProvider } from './toast'
import { GlobalSearch } from './GlobalSearch'
import { ProfileModal } from './ProfileModal'
import { Sidebar, sidebarWidth, type Brand } from './Sidebar'
import { OWN_BACK } from './nav'

const COLLAPSED_KEY = 'vt.sideCol'
const STACK_LIMIT = 30

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const writeCollapsed = (v: boolean) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    // Not remembered when storage is blocked.
  }
}

/**
 * The route guard and the shell. No session goes to the sign-in page. A page
 * the role cannot open shows the access-denied message and goes to Dashboard.
 */
export function Shell() {
  const session = useSession()
  const { pathname } = useLocation()
  const page = pageOfPath(pathname)

  if (!session) return <Navigate to="/login" replace />
  if (!page) return <Navigate to="/dashboard" replace />
  return (
    <ToastProvider>
      {canAccess(session.role, page) ? (
        <Frame session={session} page={page}>
          <Outlet />
        </Frame>
      ) : (
        <AccessDenied role={session.role} page={page} />
      )}
    </ToastProvider>
  )
}

/** Shows the access-denied message and sends the user to Dashboard. */
function AccessDenied({ role, page }: { role: Session['role']; page: PageName }) {
  const navigate = useNavigate()
  const show = useToast()
  useEffect(() => {
    show(`Your role (${ROLE_LABEL[role]}) does not have access to ${page.replace(' v6', '')}`)
    navigate(PAGE_PATH.Dashboard, { replace: true })
  }, [role, page, show, navigate])
  return null
}

/** The page frame: sidebar, top bar with search, the Back button and the page itself. */
function Frame({ session, page, children }: { session: Session; page: PageName; children: ReactNode }) {
  useLiveSync()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [profileOpen, setProfileOpen] = useState(false)
  /** Pages visited before this one, most recent last. */
  const [stack, setStack] = useState<PageName[]>([])
  const last = useRef<PageName | null>(null)
  const popping = useRef(false)

  const people = usePeople().data ?? []
  const companies = useCompanies().data ?? []
  const person = findPerson(people, session.personId)
  const client = isClientRole(session.role)

  const brand: Brand | null = client
    ? {
        name: session.role === 'cadmin' ? `${session.org} admin panel` : `${session.org} project portal`,
        logo: companies.find(c => c.id === session.orgId)?.logo || logoFor(session.org),
      }
    : null

  useEffect(() => {
    const prev = last.current
    if (prev !== null && prev !== page && prev !== 'Login') {
      if (popping.current) popping.current = false
      else setStack(s => [...s, prev].slice(-STACK_LIMIT))
    }
    last.current = page
    window.scrollTo(0, 0)
  }, [page, pathname])

  const back = stack[stack.length - 1]
  const goBack = () => {
    if (!back) return
    popping.current = true
    setStack(s => s.slice(0, -1))
    navigate(PAGE_PATH[back])
  }

  const toggle = () => {
    setCollapsed(c => {
      writeCollapsed(!c)
      return !c
    })
  }

  const signOut = () => {
    if (apiMode) void apiSignOut()
    clearSession()
    // The next person must never see this person's data, not even for a moment.
    qc.clear()
    navigate(PAGE_PATH.Login, { replace: true })
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <Sidebar
        session={session}
        person={person}
        page={page}
        collapsed={collapsed}
        brand={brand}
        onToggle={toggle}
        onProfile={() => setProfileOpen(true)}
        onSignOut={signOut}
      />
      <div className="min-w-0 transition-[margin] duration-200" style={{ marginLeft: sidebarWidth(collapsed) }}>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 bg-[rgba(246,249,252,0.92)] px-7 shadow-[inset_0_-1px_0_rgba(27,45,69,0.10)] backdrop-blur-[6px]">
          <GlobalSearch />
          {/* Pages put their own controls here (see HeaderSlot). */}
          <div id={HEADER_SLOT_ID} className="flex min-w-0 flex-1 items-center justify-end gap-2.5" />
        </header>
        {!OWN_BACK.includes(page) && (
          <div className="px-7 pt-4">
            <button
              type="button"
              onClick={goBack}
              disabled={!back}
              title={back ? `Back to ${back.replace(' v6', '')}` : 'Back'}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:text-ink"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Back
            </button>
          </div>
        )}
        {children}
      </div>
      {profileOpen && <ProfileModal session={session} person={person} onClose={() => setProfileOpen(false)} />}
    </div>
  )
}
