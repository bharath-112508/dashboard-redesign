import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useDevops, useSend } from '../../api/queries'
import type { DevopsDb, DvLog, DvProject } from '../../api/devops/types'
import { DV_ME, FIELD_LABEL, lad, statusDesc, type FieldKey } from './model'

/** The status change window: which project, the new status and its draft description and dates. */
export interface StatusChange {
  key: string
  to: string
  note: string
  due: string
  start: string
}

/** Windows opened by the URL, so the back button closes them and links can point at them. */
export type DvWindow = 'project' | 'tab' | 'request' | 'question' | 'settings' | 'new'

type Log = Omit<DvLog, 'by' | 'when'>

interface DvApi {
  db: DevopsDb
  /** Changes a project and optionally adds an Activity entry. */
  update: (key: string, patch: Partial<DvProject>, log?: Log) => void
  /** Changes a Details field and logs it with the old value. Status changes open the status window. */
  setField: (p: DvProject, k: FieldKey, value: string) => void
  get: (w: DvWindow) => string | null
  open: (patch: Partial<Record<DvWindow, string | null>>, replace?: boolean) => void
  /** The open dropdown (one at a time). */
  dd: string | null
  setDd: (k: string | null) => void
  chg: StatusChange | null
  setChg: (c: StatusChange | null | ((c: StatusChange | null) => StatusChange | null)) => void
}

const Ctx = createContext<DvApi | null>(null)

export function DevopsProvider({ children }: { children: ReactNode }) {
  const db = useDevops().data
  if (!db) return null
  return <Inner db={db}>{children}</Inner>
}

function Inner({ db, children }: { db: DevopsDb; children: ReactNode }) {
  const send = useSend()
  const [params, setParams] = useSearchParams()
  const [dd, setDd] = useState<string | null>(null)
  const [chg, setChg] = useState<StatusChange | null>(null)

  const update = useCallback(
    (key: string, patch: Partial<DvProject>, log?: Log) => send({ type: 'devops.project.update', key, patch, log }),
    [send],
  )

  const get = useCallback((w: DvWindow) => params.get(w), [params])
  const open = useCallback(
    (patch: Partial<Record<DvWindow, string | null>>, replace = false) =>
      setParams(
        p => {
          const n = new URLSearchParams(p)
          Object.entries(patch).forEach(([k, v]) => (v == null ? n.delete(k) : n.set(k, v)))
          return n
        },
        { replace },
      ),
    [setParams],
  )

  const setField = useCallback(
    (sp: DvProject, k: FieldKey, value: string) => {
      const own = k === 'owner' || k === 'devOwner'
      const old = own ? sp[k] || 'Unassigned' : (sp[k] as string | undefined) || '—'
      if (value === old) return
      if (k === 'infra') {
        setDd(null)
        setChg({ key: sp.key, to: value, note: statusDesc(db.settings, value), due: sp.initDue || '', start: '' })
        return
      }
      const patch: Partial<DvProject> = { [k]: value, updatedBy: DV_ME }
      if (own) (patch as Record<string, unknown>)[k] = value === 'Unassigned' ? null : value
      if (k === 'act') {
        const i = lad(sp, db.settings).indexOf(value)
        patch.step = i >= 0 ? i : null
        if (i < 0) patch.overdue = false
      }
      if (k === 'from' && value !== 'Client' && sp.step != null) {
        patch.step = null
        patch.act = 'Not required'
        patch.overdue = false
      }
      update(sp.key, patch, { type: 'Field change', text: FIELD_LABEL[k] + ' changed to ' + value, detail: 'Was: ' + old })
    },
    [db.settings, update],
  )

  // Escape closes the innermost thing: the status window, a menu, then the top window.
  const st = useRef({ chg, dd, get, open })
  st.current = { chg, dd, get, open }
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = st.current
      if (s.chg) return setChg(null)
      if (s.dd) return setDd(null)
      if (s.get('question')) return s.open({ question: null }, true)
      if (s.get('request')) return s.open({ request: null }, true)
      if (s.get('settings')) return s.open({ settings: null }, true)
      if (s.get('new')) return s.open({ new: null }, true)
      if (s.get('project')) return s.open({ project: null, tab: null }, true)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const v = useMemo<DvApi>(
    () => ({ db, update, setField, get, open, dd, setDd, chg, setChg }),
    [db, update, setField, get, open, dd, chg],
  )
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>
}

export const useDv = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDv must be used inside DevopsProvider')
  return v
}
