import { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * A short, non-blocking notice for data that could not be saved in this
 * browser (for example when storage is full). The mock backend reports
 * problems here; the notice mounts itself the first time one is reported, so
 * the app shell does not need to render it.
 */

let problem: string | null = null
let root: Root | null = null
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const snapshot = () => problem

const mount = () => {
  if (root || typeof document === 'undefined') return
  const el = document.createElement('div')
  el.dataset.saveNotice = ''
  document.body.appendChild(el)
  root = createRoot(el)
  root.render(<SaveNotice />)
}

/** Sets the notice text, or clears it with null. Same text twice is a no-op. */
export const setSaveProblem = (text: string | null) => {
  if (text === problem) return
  problem = text
  if (text) mount()
  listeners.forEach(fn => fn())
}

export function SaveNotice() {
  const text = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!text) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[200] flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-[560px] items-start gap-3 rounded-lg bg-[#2B2110] px-4 py-3 text-[13px] leading-snug text-white shadow-lg">
        <span className="flex-1">{text}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setSaveProblem(null)}
          className="cursor-pointer border-0 bg-transparent px-1 text-[16px] leading-none text-white/80 hover:text-white"
        >
          ×
        </button>
      </div>
    </div>
  )
}
