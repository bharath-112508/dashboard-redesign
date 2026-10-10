import { createContext, useContext, useEffect } from 'react'

/**
 * Lets an edit inside a conversation window hold the window-level Escape.
 * While any hold is active, Escape does nothing, so an open description edit
 * or an unsent chat draft is kept and the window stays open.
 */
export type EscapeHold = (id: string, on: boolean) => void

export const EscapeHoldContext = createContext<EscapeHold>(() => {})

export function useEscapeHold(id: string, on: boolean) {
  const hold = useContext(EscapeHoldContext)
  useEffect(() => {
    hold(id, on)
    return () => hold(id, false)
  }, [hold, id, on])
}
