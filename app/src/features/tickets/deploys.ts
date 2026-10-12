import { useSyncExternalStore } from 'react'
import type { DvProject, DvRelease } from '../../api/devops/types'
import { short, TODAY } from '../../lib/dates'

/**
 * Release notices on the Tickets page: the "NEW" badge on the DevOps button and
 * the "… is live" toast. Which release each viewer has seen is a per-browser
 * convenience, so it is kept in localStorage by person and project. The DevOps
 * panel's open state lives here too, so the toast can open it.
 */

const KEY = 'vt.deploySeen'

type Marks = { seen: Record<string, string>; toasted: Record<string, string> }

const load = (): Marks => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && typeof v === 'object') return { seen: v.seen || {}, toasted: v.toasted || {} }
  } catch {
    /* storage unavailable */
  }
  return { seen: {}, toasted: {} }
}

interface State {
  marks: Marks
  /** The DevOps panel in the epic bar. */
  panel: { open: boolean; tab: 'status' | 'req' }
  /** The release the toast is showing, by project key. */
  toast: string | null
}

let state: State = { marks: load(), panel: { open: false, tab: 'status' }, toast: null }
const subs = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach(f => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

const mark = (kind: keyof Marks, id: string, v: string) => {
  const marks = { ...state.marks, [kind]: { ...state.marks[kind], [id]: v } }
  try {
    localStorage.setItem(KEY, JSON.stringify(marks))
  } catch {
    /* storage unavailable */
  }
  emit({ marks })
}

export const useDeployState = () => useSyncExternalStore(subscribe, () => state)

const markId = (me: number, key: string) => me + ':' + key

/** The newest release, or null when the project has none. */
export const latestRelease = (p?: DvProject | null): DvRelease | null => p?.releases?.[0] ?? null

/** True when the newest release of the project is one this person hasn't seen yet. */
export const isUnseen = (marks: Marks, me: number, p?: DvProject | null) => {
  const r = latestRelease(p)
  return !!r && !!p && marks.seen[markId(me, p.key)] !== r.v
}

/** True when the toast for the newest release hasn't been shown to this person yet. */
export const needsToast = (marks: Marks, me: number, p?: DvProject | null) => {
  const r = latestRelease(p)
  return !!r && !!p && r.st === 'Live' && isUnseen(marks, me, p) && marks.toasted[markId(me, p.key)] !== r.v
}

export const deploys = {
  setPanel: (open: boolean, tab?: 'status' | 'req') => emit({ panel: { open, tab: tab ?? state.panel.tab } }),
  setTab: (tab: 'status' | 'req') => emit({ panel: { ...state.panel, tab } }),
  /** Marks the project's newest release as seen and hides its toast. */
  seen: (me: number, p?: DvProject | null) => {
    const r = latestRelease(p)
    if (p && r && state.marks.seen[markId(me, p.key)] !== r.v) mark('seen', markId(me, p.key), r.v)
    if (state.toast) emit({ toast: null })
  },
  showToast: (me: number, p: DvProject) => {
    const r = latestRelease(p)
    if (!r) return
    mark('toasted', markId(me, p.key), r.v)
    emit({ toast: p.key })
  },
  hideToast: () => state.toast && emit({ toast: null }),
}

/** "Today" for today's releases, otherwise "9 Oct". */
export const releaseDay = (r: DvRelease) => (r.at.slice(0, 10) === TODAY ? 'Today' : short(r.at.slice(0, 10)))
