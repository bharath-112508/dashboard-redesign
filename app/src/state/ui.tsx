import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import type { Priority, TaskType } from '../api/types'

/** Board filters and selections shared by the Clients page views. */
interface UiState {
  /** The epic the page is focused on. */
  epic: string
  /** Epics picked in the epic picker (always includes `epic`). */
  epSel: string[]
  /** Sprints picked in the sprint picker; null means all. 'backlog' = no sprint. */
  spSel: string[] | null
  q: string
  mine: boolean
  typeF: TaskType | ''
  prioF: Priority | ''
}

interface UiApi extends UiState {
  set: (patch: Partial<UiState>) => void
  setEpics: (ids: string[]) => void
  clearFilters: () => void
  hasFilters: boolean
}

const Ctx = createContext<UiApi | null>(null)

export function UiProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<UiState>({ epic: 'mob', epSel: ['mob'], spSel: null, q: '', mine: false, typeF: '', prioF: '' })
  const set = useCallback((patch: Partial<UiState>) => setS(p => ({ ...p, ...patch })), [])
  const setEpics = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      setS(p => ({ ...p, epSel: ids, epic: ids.includes(p.epic) ? p.epic : ids[0], spSel: null }))
    },
    [],
  )
  const clearFilters = useCallback(() => setS(p => ({ ...p, mine: false, typeF: '', prioF: '', q: '' })), [])
  const v = useMemo<UiApi>(
    () => ({ ...s, set, setEpics, clearFilters, hasFilters: s.mine || !!s.typeF || !!s.prioF || !!s.q }),
    [s, set, setEpics, clearFilters],
  )
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>
}

export const useUi = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUi must be used inside UiProvider')
  return v
}

/**
 * Pop-up windows are driven by the URL (e.g. ?ticket=12), so the browser's
 * back button closes them and a link can open a ticket directly.
 */
export type Overlay = 'ticket' | 'bug' | 'question' | 'request' | 'sprint' | 'epic' | 'report' | 'newEpic' | 'newSprint'

const OVERLAYS: Overlay[] = ['ticket', 'bug', 'question', 'request', 'sprint', 'epic', 'report', 'newEpic', 'newSprint']

export const useOverlay = () => {
  const [params, setParams] = useSearchParams()
  // Keep the page's navigation state (it drives the "Back to …" button).
  const { state } = useLocation()
  const get = useCallback((o: Overlay) => params.get(o), [params])
  /** Opens one overlay, closing any other. */
  const open = useCallback(
    (o: Overlay, value: string | number = '1', opts: { replace?: boolean; keep?: Overlay[] } = {}) => {
      setParams(
        p => {
          const n = new URLSearchParams(p)
          OVERLAYS.forEach(k => {
            if (!opts.keep?.includes(k)) n.delete(k)
          })
          n.set(o, String(value))
          return n
        },
        { replace: opts.replace, state },
      )
    },
    [setParams, state],
  )
  const close = useCallback(
    (...os: Overlay[]) =>
      setParams(
        p => {
          const n = new URLSearchParams(p)
          ;(os.length ? os : OVERLAYS).forEach(k => n.delete(k))
          return n
        },
        { replace: true, state },
      ),
    [setParams, state],
  )
  return { get, open, close }
}
