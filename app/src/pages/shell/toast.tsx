import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type Show = (message: string) => void

const ToastContext = createContext<Show>(() => undefined)

/** A short message at the bottom of the screen, hidden after a few seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef(0)

  const show = useCallback<Show>(text => {
    setMessage(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(null), 2600)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {message && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-[10px] bg-ink px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_10px_30px_rgba(27,45,69,0.3)]"
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
