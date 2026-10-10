import { useEffect, useRef } from 'react'

/** Calls `fn` when Escape is pressed while the component is mounted. */
export const useEscape = (fn: () => void) => {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ref.current()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
}
