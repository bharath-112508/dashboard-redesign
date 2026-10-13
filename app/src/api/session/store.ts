import { useSyncExternalStore } from 'react'
import { ROLE_LABEL } from './access'
import type { Session } from '../types'

/**
 * The signed-in user, kept in this browser (`vt.session`). It is a convenience
 * for the front end: every read is wrapped, so a blocked or full storage just
 * means "signed out".
 */
const KEY = 'vt.session'
const CHANGED = 'vt-session-changed'

const isSession = (v: unknown): v is Session => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.personId === 'number' && typeof s.name === 'string' && typeof s.role === 'string' && s.role in ROLE_LABEL
}

const readRaw = (): string | null => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** The stored session, or null when there is none or it is damaged. */
export const readSession = (): Session | null => {
  const raw = readRaw()
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    return isSession(v) ? v : null
  } catch {
    return null
  }
}

export const writeSession = (s: Session) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage is full or blocked. The user stays signed out on reload.
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** Keys older builds kept for the session that sign-in removes (spec 01 data effect: the prototype's role switch). */
const LEGACY_KEYS = ['vt.dashRole']

/** Signs a person in: drops the legacy keys, then stores the new session. */
export const startSession = (s: Session) => {
  for (const k of LEGACY_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      // Storage is blocked; there is nothing to remove.
    }
  }
  writeSession(s)
}

export const clearSession = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
  window.dispatchEvent(new Event(CHANGED))
}

const subscribe = (onChange: () => void) => {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGED, onChange)
  }
}

// useSyncExternalStore needs a stable snapshot, so the parsed session is reused while the raw text is unchanged.
let lastRaw: string | null | undefined
let lastSession: Session | null = null
const snapshot = (): Session | null => {
  const raw = readRaw()
  if (raw !== lastRaw) {
    lastRaw = raw
    lastSession = readSession()
  }
  return lastSession
}

/** The signed-in user, or null. Updates when the session is written or cleared, here or in another tab. */
export const useSession = (): Session | null => useSyncExternalStore(subscribe, snapshot, () => null)
