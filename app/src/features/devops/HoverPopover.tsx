import { useCallback, useRef, useState, type MouseEvent } from 'react'
import { useDv } from './ctx'
import { infraText, tone } from './model'

interface PopState {
  key: string
  kind: 'infra' | 'phase'
  left: number
  top: number
}

/** Hover cards on the list: the status (with an editable description) and the full current phase. */
export const usePopover = () => {
  const [pop, setPop] = useState<PopState | null>(null)
  const [draft, setDraft] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const dirty = useRef(false)
  const { db } = useDv()
  const dbRef = useRef(db)
  dbRef.current = db

  const openAt = useCallback((e: MouseEvent, key: string, kind: PopState['kind']) => {
    window.clearTimeout(timer.current)
    const r = e.currentTarget.getBoundingClientRect()
    const left = Math.min(r.left, window.innerWidth - 356)
    const below = r.bottom + 6
    const top = below + 260 > window.innerHeight ? Math.max(8, r.top - 6 - (kind === 'infra' ? 230 : 140)) : below
    const p = dbRef.current.projects.find(x => x.key === key)
    if (kind === 'infra' && p) setDraft(infraText(p, dbRef.current.settings))
    dirty.current = false
    setPop({ key, kind, left, top })
  }, [])
  const enter = useCallback(() => window.clearTimeout(timer.current), [])
  const leaveSoon = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      // Keep it open while someone is typing a change into it.
      if (document.activeElement?.tagName === 'TEXTAREA' && dirty.current) return
      setPop(null)
    }, 180)
  }, [])
  const close = useCallback(() => setPop(null), [])
  const edit = useCallback((v: string) => {
    dirty.current = true
    setDraft(v)
  }, [])
  return { pop, draft, setDraft: edit, openAt, enter, leaveSoon, close }
}

export type Popover = ReturnType<typeof usePopover>

export function HoverPopover({ pop: P }: { pop: Popover }) {
  const { db, update } = useDv()
  const pp = P.pop
  const c = pp && db.projects.find(x => x.key === pp.key)
  if (!pp || !c) return null
  const isInfra = pp.kind === 'infra'
  const st = tone(c.infra)
  const base = infraText(c, db.settings)
  const dirty = isInfra && P.draft !== base
  return (
    <div
      onMouseEnter={P.enter}
      onMouseLeave={P.leaveSoon}
      onClick={e => e.stopPropagation()}
      className="fixed z-[25] w-[340px] rounded-[14px] bg-white p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.06)]"
      style={{ left: pp.left, top: pp.top }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
          {isInfra ? 'Status' : c.phase ? 'Current phase' : 'Next DevOps phase'}
        </span>
        <span className="ml-auto text-[12px] text-slate">{c.name}</span>
      </div>
      {isInfra ? (
        <>
          <div className="mt-2">
            <span className="rounded-md px-2 py-[3px] text-[12px] font-semibold" style={{ color: st[0], background: st[1] }}>
              {c.infra}
            </span>
          </div>
          <textarea
            value={P.draft}
            onChange={e => P.setDraft(e.target.value)}
            rows={4}
            placeholder="Describe where this project stands…"
            className="mt-2.5 w-full resize-y rounded-[10px] border-0 bg-canvas px-[11px] py-[9px] text-[13px] leading-normal text-ink outline-0"
          />
          {dirty && (
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={() => P.setDraft(base)} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted">
                Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  const t = P.draft.trim()
                  update(c.key, { infraNote: t }, { type: 'Field change', text: 'Status description updated', detail: t })
                  P.close()
                }}
                className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-blue-ink"
              >
                Save &amp; log
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 text-[14px] leading-normal text-ink [text-wrap:pretty]">{c.phase || c.next || 'No notes yet'}</div>
      )}
    </div>
  )
}
