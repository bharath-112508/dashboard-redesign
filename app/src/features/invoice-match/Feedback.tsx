import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref, type RefObject } from 'react'
import { useCompanies, useSendAsync, useTasks } from '../../api/queries'
import type { Attachment, ClientPriority } from '../../api/types'
import { fileSize, nextTaskId, taskKey } from '../../domain/tasks'
import { MON, TODAY, todayLabel } from '../../lib/dates'
import { blobToDataUrl, captureElement, startRecording, type Rect } from './capture'
import { imBugEpic, imProjectOf } from './data'
import { apiMode } from '../../api/http/config'

export type FeedbackApi = { start: (snip: boolean) => void }

type Mode = 'snip' | 'panel' | 'done'

interface Fb {
  mode: Mode
  title: string
  desc: string
  prio: ClientPriority
  tried?: boolean
  /** PNG data URL of the snippet or screenshot, or an uploaded image. */
  shot: string
  shotName?: string
  busy?: boolean
  failed?: boolean
  failMsg?: string
  /** Object URL of the recording or uploaded video, for the preview. */
  vid?: string
  vidBlob?: Blob
  vidName?: string
  recording?: boolean
  recS?: number
  /** Drag start and end while snipping, relative to the app. */
  a?: { x: number; y: number } | null
  b?: { x: number; y: number } | null
  /** The new bug's id; its key is read from the ticket list (in API mode the backend numbers it). */
  doneId?: string
  sending?: boolean
}

const fresh = (mode: Mode): Fb => ({ mode, title: '', desc: '', prio: 'Medium', shot: '' })
const PRIOS: ClientPriority[] = ['Low', 'Medium', 'High', 'Critical']
/** Videos above this keep their name and size but not their contents. */
const MAX_VIDEO = 25e6
const IGNORE = (el: Element) => (el as HTMLElement).dataset?.imIgnore === '1'

const sizeOfDataUrl = (u: string) => fileSize(Math.round(((u.length - u.indexOf(',') - 1) * 3) / 4))

const now = () => {
  const d = new Date()
  const [, m, day] = TODAY.split('-')
  return `${+day} ${MON[+m - 1]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const fieldCls = 'w-full rounded-[9px] border border-[#D5DCE6] bg-white text-[14px] text-[#111827] outline-0'
const smallBtn = 'h-[26px] cursor-pointer rounded-[7px] border px-[9px] text-[11.5px] font-bold'
const tileCls =
  'flex h-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border border-dashed border-[#A9B6C5] bg-white text-[12px] font-bold hover:bg-[#F5F8FF]'

/**
 * "Send feedback" in the live app: a snippet (drag over part of the app), a
 * screenshot of the whole app, a screen recording or an upload, plus a title,
 * description and how bad it is. Sending creates a client bug on the
 * InvoiceMatch board (a normal `task.create`), so the team sees it on the
 * Clients board and in Tickets; the capture is stored as its attachment.
 */
export function Feedback({
  ref,
  rootRef,
  embedded,
  me,
  pageName,
  ctxLabel,
}: {
  ref: Ref<FeedbackApi>
  rootRef: RefObject<HTMLDivElement | null>
  embedded: boolean
  me: string
  pageName: string
  ctxLabel: string
}) {
  const [fb, setFb] = useState<Fb | null>(null)
  const set = (p: Partial<Fb>) => setFb(s => (s ? { ...s, ...p } : s))
  const drag = useRef<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const recorder = useRef<{ stop: () => void } | null>(null)
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)
  const sendAsync = useSendAsync()
  const tasks = useTasks().data ?? []
  // Bugs go to the project's "Review & reports" epic.
  const bugEpic = imBugEpic(imProjectOf(useCompanies().data)?.project)
  // The new bug's key once the ticket list has it (API mode: the backend's key, e.g. IM-3).
  const doneTask = fb?.doneId != null ? tasks.find(t => t.id === fb.doneId) : undefined
  const doneKey = fb?.doneId == null ? '' : doneTask ? taskKey(doneTask) : apiMode ? '' : taskKey({ id: fb.doneId })

  const start = (snip: boolean) =>
    setFb(s => (s && s.mode !== 'done' ? { ...s, mode: snip ? 'snip' : 'panel', a: null, b: null } : fresh(snip ? 'snip' : 'panel')))
  useImperativeHandle(ref, () => ({ start }), [])

  const close = () => {
    recorder.current?.stop()
    setFb(null)
  }
  const back = () => (fb?.mode === 'snip' ? set({ mode: 'panel', a: null, b: null }) : close())

  // ⌘⇧5 / Ctrl+Shift+5 starts a snippet; Escape leaves the snippet, then closes the panel.
  const fbRef = useRef(fb)
  fbRef.current = fb
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'Digit5' || e.key === '5' || e.key === '%')) {
        e.preventDefault()
        start(true)
      } else if (e.key === 'Escape' && fbRef.current && !fbRef.current.recording) {
        e.stopPropagation()
        if (fbRef.current.mode === 'snip') setFb(s => (s ? { ...s, mode: 'panel', a: null, b: null } : s))
        else setFb(null)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Stop a recording and free previews when the app closes.
  const vidUrl = useRef<string | undefined>(undefined)
  vidUrl.current = fb?.vid
  useEffect(
    () => () => {
      recorder.current?.stop()
      clearInterval(timer.current)
      if (vidUrl.current) URL.revokeObjectURL(vidUrl.current)
    },
    [],
  )

  const capture = async (rect: Rect | null) => {
    const el = rootRef.current
    if (!el) return
    setFb(s => ({ ...(s ?? fresh('panel')), mode: 'panel', busy: true, failed: false, shot: '', a: null, b: null }))
    let shot = ''
    try {
      // Let the snipping layer leave the screen first.
      await new Promise(r => setTimeout(r, 80))
      shot = await captureElement(el, rect, { ignore: IGNORE, background: '#F4F6FA' })
    } catch {
      shot = ''
    }
    setFb(s =>
      s
        ? {
            ...s,
            busy: false,
            shot,
            failed: !shot,
            failMsg: 'The screenshot could not be captured. Try upload instead.',
            shotName: (rect ? 'snippet-' : 'screenshot-') + pageName + '.png',
          }
        : s,
    )
  }

  const pt = (e: ReactPointerEvent) => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }
  }

  const record = async () => {
    clearInterval(timer.current)
    const res = await startRecording(r => {
      clearInterval(timer.current)
      recorder.current = null
      const url = URL.createObjectURL(r.blob)
      setFb(s => {
        if (!s) {
          URL.revokeObjectURL(url)
          return s
        }
        if (s.vid) URL.revokeObjectURL(s.vid)
        return { ...s, mode: 'panel', recording: false, vid: url, vidBlob: r.blob, vidName: `recording-${pageName}-${r.secs}s.${r.ext}`, failed: false }
      })
    })
    if ('failMsg' in res) {
      set({ failed: true, failMsg: res.failMsg })
      return
    }
    recorder.current = res
    const t0 = Date.now()
    set({ recording: true, recS: 0, failed: false })
    timer.current = setInterval(() => set({ recS: Math.round((Date.now() - t0) / 1000) }), 500)
  }

  const upload = (file: File | undefined) => {
    if (!file) return
    if (/^video\//.test(file.type)) {
      setFb(s => {
        if (!s) return s
        if (s.vid) URL.revokeObjectURL(s.vid)
        return { ...s, vid: URL.createObjectURL(file), vidBlob: file, vidName: file.name, failed: false }
      })
      return
    }
    blobToDataUrl(file)
      .then(u => set({ shot: u, shotName: file.name, failed: false }))
      .catch(() => set({ failed: true, failMsg: 'That file could not be read.' }))
  }

  const ctx = ctxLabel + ' · ' + now()

  const submit = async () => {
    if (!fb || fb.sending) return
    const title = fb.title.trim()
    if (!title) {
      set({ tried: true })
      return
    }
    set({ sending: true })
    const ds = todayLabel()
    const atts: Attachment[] = []
    if (fb.shot) atts.push({ name: fb.shotName || 'snippet.png', size: sizeOfDataUrl(fb.shot), date: ds, url: fb.shot })
    if (fb.vidBlob) {
      const url = fb.vidBlob.size <= MAX_VIDEO ? await blobToDataUrl(fb.vidBlob).catch(() => '') : ''
      atts.push({ name: fb.vidName || 'recording.webm', size: fileSize(fb.vidBlob.size), date: ds, url })
    }
    try {
      const res = await sendAsync({
        type: 'task.create',
        top: true,
        task: {
          id: nextTaskId(tasks),
          title,
          type: 'Bug',
          status: 'todo',
          prio: fb.prio,
          due: '',
          assignee: '',
          assignees: [],
          contribs: [],
          est: '',
          desc: ((fb.desc || '').trim() + '\n\nSent from: ' + ctx).trim(),
          atts,
          subs: [],
          deps: [],
          epic: bugEpic,
          sprint: null,
          start: TODAY,
          time: {},
          acts: [{ kind: 'history', who: me, what: 'reported this bug from the live app', when: 'just now' }],
          clientBug: { reported: ds, chat: [] },
        },
      })
      set({ mode: 'done', sending: false, doneId: res.id != null ? String(res.id) : undefined })
    } catch {
      set({ sending: false, failed: true, failMsg: 'Your feedback could not be sent. Try again.' })
    }
  }

  if (!fb) return null

  const sel = fb.a && fb.b ? { x: Math.min(fb.a.x, fb.b.x), y: Math.min(fb.a.y, fb.b.y), w: Math.abs(fb.a.x - fb.b.x), h: Math.abs(fb.a.y - fb.b.y) } : null
  const hasSel = !!sel && sel.w > 2
  const titleErr = fb.tried && !fb.title.trim() ? 'Add a title' : ''
  const recT = Math.floor((fb.recS ?? 0) / 60) + ':' + String((fb.recS ?? 0) % 60).padStart(2, '0')
  const noShot = !fb.busy && !fb.shot && !fb.vid
  const panel = (fb.mode === 'panel' || fb.mode === 'done') && !fb.recording

  return (
    <>
      {fb.mode === 'snip' && (
        <div
          data-im-ignore="1"
          data-testid="im-snip"
          onPointerDown={e => {
            if (e.button !== 0) return
            const p = pt(e)
            drag.current = { a: p, b: p }
            ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
            set({ a: p, b: p })
          }}
          onPointerMove={e => {
            if (!drag.current) return
            const p = pt(e)
            drag.current.b = p
            set({ b: p })
          }}
          onPointerUp={e => {
            const d = drag.current
            drag.current = null
            if (!d) return
            const p = pt(e)
            const r = { x: Math.min(d.a.x, p.x), y: Math.min(d.a.y, p.y), w: Math.abs(d.a.x - p.x), h: Math.abs(d.a.y - p.y) }
            if (r.w > 12 && r.h > 12) void capture(r)
            else set({ a: null, b: null })
          }}
          className="absolute inset-0 z-[80] cursor-crosshair select-none touch-none"
          style={{ background: hasSel ? 'transparent' : 'rgba(15,30,61,0.5)' }}
        >
          {hasSel && sel && (
            <div
              className="pointer-events-none absolute rounded-[3px] border-2 border-white shadow-[0_0_0_9999px_rgba(15,30,61,0.5)]"
              style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
            >
              <span className="absolute -top-[26px] left-0 flex h-[22px] items-center whitespace-nowrap rounded-md bg-[#0F1E3D] px-2 text-[11.5px] font-bold text-white">
                {Math.round(sel.w)} × {Math.round(sel.h)}
              </span>
            </div>
          )}
          <div
            onPointerDown={e => e.stopPropagation()}
            className="absolute bottom-[22px] left-1/2 flex -translate-x-1/2 cursor-default items-center gap-1.5 whitespace-nowrap rounded-xl bg-[#0F1E3D] p-1.5 text-white shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
          >
            <span className="px-2.5 text-[13px] font-semibold text-[#C7D2E8]">Drag over the part that looks wrong</span>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                void capture(null)
              }}
              className="h-8 cursor-pointer rounded-lg border-0 bg-[#1D4ED8] px-3 text-[12.5px] font-bold text-white"
            >
              Capture whole page
            </button>
            <button type="button" onClick={back} className="h-8 cursor-pointer rounded-lg border-0 bg-white/10 px-3 text-[12.5px] font-bold text-white">
              Back · Esc
            </button>
          </div>
        </div>
      )}

      {fb.recording && (
        <div
          data-im-ignore="1"
          role="status"
          className="absolute bottom-[22px] left-1/2 z-[86] flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-xl bg-[#0F1E3D] py-[7px] pl-3.5 pr-2 text-white shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
        >
          <span className="size-2.5 rounded-full bg-[#EF4444] shadow-[0_0_0_4px_rgba(239,68,68,0.3)]" />
          <span className="text-[13px] font-bold">Recording {recT}</span>
          <span className="text-[12px] text-[#A9B8D6]">Show us what happens, then stop</span>
          <button
            type="button"
            onClick={() => recorder.current?.stop()}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-[#DC2626] px-3 text-[12.5px] font-bold text-white"
          >
            <span className="size-[9px] rounded-[2px] bg-white" />
            Stop
          </button>
        </div>
      )}

      {panel && (
        <>
          <div data-im-ignore="1" onClick={close} className="absolute inset-0 z-[84] bg-[rgba(15,30,61,0.18)]" />
          <div
            data-im-ignore="1"
            role="dialog"
            aria-label="Send feedback"
            className="absolute right-3.5 z-[85] max-h-[calc(100%-80px)] w-[min(390px,calc(100%-28px))] overflow-y-auto rounded-2xl bg-white shadow-[0_0_0_1px_#E3E8EF,0_24px_60px_-12px_rgba(15,30,61,0.4)]"
            style={{ top: embedded ? 108 : 68 }}
          >
            {fb.mode === 'panel' ? (
              <div className="px-[18px] pb-[18px] pt-4">
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[16px] font-extrabold tracking-[-0.01em]">Send feedback</div>
                    <div className="mt-px text-[12px] text-[#4B5563]">The Viljetech team gets it right away.</div>
                  </div>
                  <button type="button" onClick={close} title="Close" aria-label="Close" className="size-[30px] cursor-pointer rounded-lg border-0 bg-[#F3F4F6] text-[16px] text-[#111827]">
                    ×
                  </button>
                </div>
                <label className="mt-4 block">
                  <span className="mb-1.5 block text-[12.5px] font-bold text-[#374151]">
                    Title <span className="text-[#B91C1C]">*</span>
                  </span>
                  <input
                    autoFocus
                    value={fb.title}
                    onChange={e => set({ title: e.target.value })}
                    placeholder="What went wrong?"
                    className={fieldCls + ' h-10 px-3'}
                    style={{ borderColor: titleErr ? '#B91C1C' : '#D5DCE6' }}
                  />
                </label>
                {titleErr && <div className="mt-[5px] text-[12px] font-semibold text-[#B91C1C]">{titleErr}</div>}
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-[12.5px] font-bold text-[#374151]">Description</span>
                  <textarea
                    value={fb.desc}
                    onChange={e => set({ desc: e.target.value })}
                    rows={3}
                    placeholder="What did you do, what did you expect, what happened instead?"
                    className={fieldCls + ' resize-y px-3 py-2.5 leading-[1.45]'}
                  />
                </label>
                <div className="mt-3">
                  <span className="mb-1.5 block text-[12.5px] font-bold text-[#374151]">How bad is it?</span>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="How bad is it?">
                    {PRIOS.map(p => {
                      const on = fb.prio === p
                      const crit = p === 'Critical'
                      return (
                        <button
                          key={p}
                          type="button"
                          aria-pressed={on}
                          onClick={() => set({ prio: p })}
                          className="h-8 cursor-pointer rounded-lg border px-[11px] text-[12.5px] font-bold"
                          style={{
                            borderColor: on ? (crit ? '#B91C1C' : '#1D4ED8') : '#D5DCE6',
                            background: on ? (crit ? '#FEF2F2' : '#EFF6FF') : '#fff',
                            color: on ? (crit ? '#B91C1C' : '#1D4ED8') : '#374151',
                          }}
                        >
                          {p}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="mt-3.5">
                  <span className="mb-1.5 block text-[12.5px] font-bold text-[#374151]">
                    Snippet, screenshot or video <span className="font-medium text-[#6B7280]">(optional)</span>
                  </span>
                  {!fb.busy && fb.shot && (
                    <div className="relative overflow-hidden rounded-[10px] border border-[#E3E8EF] bg-[#F9FAFB]">
                      <img src={fb.shot} alt="Screenshot" className="mx-auto block max-h-[170px] max-w-full" />
                      <div className="flex items-center gap-1.5 border-t border-[#E3E8EF] px-[9px] py-[7px] text-[12px] text-[#4B5563]">
                        <span className="min-w-0 flex-1 truncate">{fb.shotName}</span>
                        <button type="button" onClick={() => start(true)} className={smallBtn + ' border-[#D5DCE6] bg-white'}>
                          Retake
                        </button>
                        <button type="button" onClick={() => set({ shot: '', failed: false })} className={smallBtn + ' border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C]'}>
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                  {fb.busy && <div className="rounded-[10px] bg-[#F9FAFB] p-[18px] text-center text-[12.5px] text-[#4B5563]">Capturing…</div>}
                  {fb.vid && (
                    <div className={'overflow-hidden rounded-[10px] border border-[#E3E8EF] bg-[#0F1E3D]' + (fb.shot ? ' mt-2' : '')}>
                      <video src={fb.vid} controls playsInline className="block max-h-[190px] w-full bg-black" />
                      <div className="flex items-center gap-1.5 border-t border-[#E3E8EF] bg-[#F9FAFB] px-[9px] py-[7px] text-[12px] text-[#4B5563]">
                        <span className="min-w-0 flex-1 truncate">
                          {fb.vidName}
                          {fb.vidBlob ? ' · ' + fileSize(fb.vidBlob.size) : ''}
                        </span>
                        <button type="button" onClick={() => void record()} className={smallBtn + ' border-[#D5DCE6] bg-white'}>
                          Re-record
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (fb.vid) URL.revokeObjectURL(fb.vid)
                            set({ vid: undefined, vidBlob: undefined, vidName: undefined })
                          }}
                          className={smallBtn + ' border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C]'}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                  {noShot && (
                    <>
                      <div className="grid grid-cols-4 gap-1.5">
                        <button type="button" onClick={() => start(true)} className={tileCls + ' text-[#1D4ED8]'}>
                          <span className="text-[15px]" aria-hidden="true">
                            ⬚
                          </span>
                          Snippet
                        </button>
                        <button type="button" onClick={() => void capture(null)} className={tileCls + ' text-[#1D4ED8]'}>
                          <span className="text-[15px]" aria-hidden="true">
                            ▭
                          </span>
                          Screenshot
                        </button>
                        <button type="button" onClick={() => void record()} className={tileCls + ' gap-[3px] text-[#B91C1C]'}>
                          <span className="size-[11px] rounded-full bg-[#DC2626] shadow-[0_0_0_3px_#FEE2E2]" aria-hidden="true" />
                          Record
                        </button>
                        <label className={tileCls + ' text-[#1D4ED8]'}>
                          <span className="text-[15px]" aria-hidden="true">
                            ↑
                          </span>
                          Upload
                          <input
                            type="file"
                            accept="image/*,video/*"
                            className="hidden"
                            onChange={e => {
                              upload(e.target.files?.[0])
                              e.target.value = ''
                            }}
                          />
                        </label>
                      </div>
                    </>
                  )}
                  {fb.failed && <div role="alert" className="mt-1.5 text-[12px] text-[#B45309]">{fb.failMsg}</div>}
                </div>
                <div className="mt-3 rounded-lg bg-[#F3F6FB] px-2.5 py-2 text-[11.5px] text-[#4B5563]">Sent with: {ctx}</div>
                <div className="mt-3.5 flex gap-2">
                  <button type="button" onClick={close} className="h-10 cursor-pointer rounded-[9px] border border-[#D5DCE6] bg-white px-3.5 text-[13.5px] font-bold">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={fb.sending || fb.busy}
                    className="h-10 flex-1 cursor-pointer rounded-[9px] border-0 bg-[#1D4ED8] px-4 text-[13.5px] font-bold text-white disabled:opacity-60"
                  >
                    {fb.sending ? 'Sending…' : 'Send bug report'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="px-5 py-[22px] text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-full bg-[#DCFCE7] text-[24px] font-extrabold text-[#16A34A]">✓</div>
                <div className="mt-3 text-[16px] font-extrabold">Thanks, it's with the team</div>
                <div className="mt-1 text-[13px] leading-[1.45] text-[#4B5563]">It is on the InvoiceMatch board under Bugs. You will see updates there.</div>
                <div className="mt-3 inline-flex items-center gap-2 rounded-[10px] bg-[#F3F6FB] px-3 py-2 text-[13px]">
                  <span data-testid="im-done-key" className="font-extrabold text-[#1D4ED8]">
                    {doneKey}
                  </span>
                  <span className="max-w-[220px] truncate text-[#111827]">{fb.title}</span>
                </div>
                <div className="mt-4 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFb(fresh('panel'))}
                    className="h-[38px] cursor-pointer rounded-[9px] border border-[#D5DCE6] bg-white px-3.5 text-[13px] font-bold"
                  >
                    Send another
                  </button>
                  <button type="button" onClick={close} className="h-[38px] cursor-pointer rounded-[9px] border-0 bg-[#1D4ED8] px-4 text-[13px] font-bold text-white">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
