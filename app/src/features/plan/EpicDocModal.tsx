import { useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useSend, useTasks, useWorkspace } from '../../api/queries'
import type { Epic, EpicListField } from '../../api/types'
import { Avatar, CloseButton } from '../../components/ui'
import { fmt, range } from '../../lib/dates'
import { pal, SPRINT_STATE } from '../../lib/theme'
import { usePage } from '../../state/page'
import { useOverlay, useUi } from '../../state/ui'
import { sprintsOf } from '../../domain/tasks'
import { useEscape } from '../useEscape'

const SECTIONS = [
  ['summary', 'Summary'],
  ['scope', 'Scope'],
  ['reqs', 'Requirements'],
  ['accept', 'Acceptance criteria'],
  ['plan', 'Delivery plan'],
  ['risks', 'Risks & dependencies'],
  ['questions', 'Open questions'],
  ['team', 'Team'],
] as const

const MARK_COLOR = (m: string) => (m === '−' ? '#A5502C' : m === '+' ? '#3F9079' : '#4870E8')

/** The epic's requirement document. */
export function EpicDocModal({ id }: { id: string }) {
  const { person, base } = usePage()
  const ws = useWorkspace().data!
  const tasks = (useTasks().data ?? []).filter(t => !t.parent)
  const send = useSend()
  const ui = useUi()
  const overlay = useOverlay()
  const navigate = useNavigate()
  const loc = useLocation()
  const [drafts, setDrafts] = useState<Partial<Record<EpicListField, string>>>({})
  const close = () => overlay.close('epic')
  useEscape(close)

  const ev = ws.epics.find(x => x.id === id)
  if (!ev) return null
  const [c] = pal(ev.p)
  const sp = sprintsOf(ws.sprints, ev.id)
  const ts = tasks.filter(t => t.epic === ev.id)
  const dn = ts.filter(t => t.status === 'done').length
  const pct = ts.length ? Math.round((dn / ts.length) * 100) : 0
  const mem = [...new Set(sp.flatMap(x => x.members))]
  const cd = ev.critDone || {}
  const update = (patch: Partial<Epic>) => send({ type: 'epic.update', id: ev.id, patch })
  const facts = [
    { l: 'Status', v: sp.some(x => x.state === 'active') ? 'In progress' : sp.length && sp.every(x => x.state === 'done') ? 'Done' : 'Planned', c: '#1F3FAF' },
    { l: 'Progress', v: pct + '%', c: '#1B2D45' },
    { l: 'Sprints', v: String(sp.length), c: '#1B2D45' },
    { l: 'Ends', v: sp.length ? fmt(sp[sp.length - 1].end) : '—', c: '#1B2D45' },
  ]

  const list = (k: EpicListField, mark: string, placeholder: string) => (
    <div className="flex flex-col gap-1.5">
      {(ev[k] || []).map((t, i) => {
        const m = mark === 'n' ? i + 1 + '.' : mark
        return (
          <div key={i} className="flex items-start gap-2.5 rounded-[10px] bg-canvas px-3 py-[9px] shadow-[inset_0_0_0_1.5px_#E4EAF0]">
            <span className="tnum min-w-[22px] flex-none pt-px text-[12.5px] font-bold" style={{ color: MARK_COLOR(m) }}>
              {m}
            </span>
            <span className="flex-1 text-[14px] leading-normal text-ink">{t}</span>
            <button
              type="button"
              onClick={() => update({ [k]: (ev[k] || []).filter((_, j) => j !== i) })}
              className="cursor-pointer border-0 bg-transparent p-0 text-[16px] text-faint hover:text-rust"
            >
              ×
            </button>
          </div>
        )
      })}
      <DraftInput
        value={drafts[k] || ''}
        onChange={v => setDrafts(d => ({ ...d, [k]: v }))}
        onEnter={v => {
          update({ [k]: [...(ev[k] || []), v] })
          setDrafts(d => ({ ...d, [k]: '' }))
        }}
        placeholder={placeholder}
      />
    </div>
  )

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[70] animate-fade-in bg-[rgba(27,45,69,0.45)]" />
      <div className="fixed bottom-4 left-1/2 top-4 z-[71] flex w-[min(1120px,calc(100vw-32px))] -translate-x-1/2 animate-pop-in overflow-hidden rounded-3xl border-[1.5px] border-line bg-white shadow-[0_40px_100px_rgba(27,45,69,0.35)]">
        <CloseButton onClick={close} className="absolute right-4 top-4 z-[3]" />
        <nav className="flex-[0_0_220px] overflow-y-auto border-r-[1.5px] border-line bg-canvas px-3.5 py-6">
          <div className="px-2 pb-2.5 text-[11px] font-extrabold uppercase tracking-[0.06em] text-muted">Requirement doc</div>
          {SECTIONS.map(([k, label], i) => (
            <a
              key={k}
              href={'#epdoc-' + k}
              onClick={e => {
                e.preventDefault()
                document.getElementById('epdoc-' + k)?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="flex gap-2 rounded-lg px-2 py-[7px] text-[13px] font-semibold text-ink-2 no-underline hover:bg-sky-2 hover:text-blue-ink"
            >
              <span className="tnum w-4 text-blue">{i + 1}</span>
              {label}
            </a>
          ))}
          <div className="mt-[18px] rounded-xl bg-white p-3 shadow-[0_0_0_1.5px_#D6DEE8]">
            <div className="text-[11px] font-bold text-muted">Progress</div>
            <div className="mt-0.5 text-[22px] font-extrabold text-ink">{pct}%</div>
            <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-sky-2">
              <div className="h-full" style={{ width: pct + '%', background: c }} />
            </div>
            <div className="mt-1.5 text-[12px] font-semibold text-ink-2">
              {dn} of {ts.length} tasks
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              close()
              ui.set({ epic: ev.id, epSel: [ev.id], spSel: null })
              navigate(base + '/board', { state: loc.state })
            }}
            className="mt-2.5 h-9 w-full cursor-pointer rounded-[10px] border-0 bg-ink text-[12.5px] font-bold text-white"
          >
            Open board →
          </button>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto scroll-smooth px-11 pb-10 pt-[30px]">
          <div className="flex items-center gap-2">
            <span className="rounded-md px-[9px] py-[3px] text-[11px] font-extrabold uppercase tracking-[0.08em] text-white" style={{ background: c }}>
              Epic
            </span>
            <span className="text-[12.5px] font-semibold text-muted">
              {sp.length ? range(sp[0].start, sp[sp.length - 1].end) + ' · ' + sp.length + ' sprints' : 'No sprints yet'}
            </span>
          </div>
          <div className="mt-2.5 font-serif text-[40px] leading-[1.05] text-ink">{ev.name}</div>
          <div className="mb-1.5 mt-4 grid grid-cols-4 gap-2">
            {facts.map(x => (
              <div key={x.l} className="rounded-xl bg-canvas px-3 py-2.5 shadow-[inset_0_0_0_1.5px_#E4EAF0]">
                <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted">{x.l}</div>
                <div className="mt-1 truncate text-[15px] font-extrabold" style={{ color: x.c }}>
                  {x.v}
                </div>
              </div>
            ))}
          </div>
          <Section n={1} id="summary" title="Summary">
            <div className="whitespace-pre-wrap text-[15.5px] leading-[1.7] text-ink [text-wrap:pretty]">{ev.story || ev.desc || 'No story written yet.'}</div>
          </Section>
          <Section n={2} id="scope" title="Scope">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="mb-2 text-[13px] font-extrabold text-green-ink">In scope</div>
                {list('inScope', '+', '+ Add what is included')}
              </div>
              <div>
                <div className="mb-2 text-[13px] font-extrabold text-rust">Out of scope</div>
                {list('outScope', '−', '+ Add what is excluded')}
              </div>
            </div>
          </Section>
          <Section n={3} id="reqs" title="Requirements">
            {list('reqs', 'n', '+ Add a requirement, e.g. Users can reset their password')}
          </Section>
          <Section n={4} id="accept" title="Acceptance criteria">
            <div className="flex flex-col gap-1.5">
              {(ev.criteria || []).map((t, i) => {
                const on = !!cd[i]
                return (
                  <div
                    key={i}
                    onClick={() => update({ critDone: { ...cd, [i]: !on } })}
                    className="flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2.5"
                    style={{ background: on ? '#EEF7F3' : '#F6F9FC', boxShadow: `inset 0 0 0 1.5px ${on ? '#3F9079' : '#E4EAF0'}` }}
                  >
                    <span
                      className="grid size-5 flex-none place-items-center rounded-[5px] border-2 text-[11px] font-extrabold text-white"
                      style={{ borderColor: on ? '#3F9079' : '#A9B6C5', background: on ? '#3F9079' : '#fff' }}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="text-[14px] font-semibold" style={{ color: on ? '#3B4A5E' : '#1B2D45', textDecoration: on ? 'line-through' : 'none' }}>
                      {t}
                    </span>
                  </div>
                )
              })}
              <DraftInput
                value={drafts.criteria || ''}
                onChange={v => setDrafts(d => ({ ...d, criteria: v }))}
                onEnter={v => {
                  update({ criteria: [...(ev.criteria || []), v] })
                  setDrafts(d => ({ ...d, criteria: '' }))
                }}
                placeholder="+ Add an acceptance criterion"
              />
            </div>
          </Section>
          <Section n={5} id="plan" title="Delivery plan">
            <div className="overflow-hidden rounded-xl shadow-[0_0_0_1.5px_#D6DEE8]">
              <div className="grid gap-3 bg-sky-2 px-3.5 py-[9px] text-[11.5px] font-bold uppercase tracking-[0.04em] text-blue-ink" style={{ gridTemplateColumns: '90px 130px minmax(0,1fr) 90px 80px' }}>
                <span>Sprint</span>
                <span>Dates</span>
                <span>Goal</span>
                <span>Status</span>
                <span className="text-right">Done</span>
              </div>
              {sp.map(x => {
                const [stInk, stSoft, stDot, stLabel] = SPRINT_STATE[x.state]
                const sts = ts.filter(t => t.sprint === x.id)
                return (
                  <div
                    key={x.id}
                    onClick={() => overlay.open('sprint', x.id)}
                    className="grid cursor-pointer items-center gap-3 border-t-[1.5px] border-sky px-3.5 py-2.5 hover:bg-canvas"
                    style={{ gridTemplateColumns: '90px 130px minmax(0,1fr) 90px 80px' }}
                  >
                    <span className="text-[13.5px] font-bold">{x.name}</span>
                    <span className="text-[12.5px] text-ink-2">{range(x.start, x.end)}</span>
                    <span className="truncate text-[13.5px]" style={{ color: x.goal ? '#1B2D45' : '#3B4A5E' }}>
                      {x.goal || 'No sprint goal yet'}
                    </span>
                    <span>
                      <span className="inline-flex items-center gap-[5px] rounded-full py-0.5 pl-1.5 pr-2 text-[11.5px] font-bold" style={{ background: stSoft, color: stInk }}>
                        <span className="size-1.5 rounded-full" style={{ background: stDot }} />
                        {stLabel}
                      </span>
                    </span>
                    <span className="tnum text-right text-[12.5px] font-semibold">
                      {sts.filter(t => t.status === 'done').length}/{sts.length} done
                    </span>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => overlay.open('newSprint', ev.id)}
              className="mt-2.5 h-9 cursor-pointer rounded-[10px] border-[1.5px] border-dashed border-faint bg-white px-3.5 text-[13px] font-bold text-blue-ink"
            >
              + Add new sprint
            </button>
          </Section>
          <Section n={6} id="risks" title="Risks & dependencies">
            {list('risks', '!', '+ Add a risk or dependency')}
          </Section>
          <Section n={7} id="questions" title="Open questions">
            {list('questions', '?', '+ Add an open question')}
          </Section>
          <Section n={8} id="team" title="Team">
            <div className="flex flex-wrap gap-2">
              {mem.map(n => {
                const m = person(n)
                return (
                  <span key={n} className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-canvas pl-[5px] pr-3 text-[13.5px] font-semibold shadow-[inset_0_0_0_1.5px_#E4EAF0]">
                    <Avatar i={m.i} bg={m.bg} size={26} radius={6} font={10.5} className="!font-bold" />
                    {n}
                  </span>
                )
              })}
            </div>
          </Section>
        </div>
      </div>
    </>
  )
}

function Section({ n, id, title, children }: { n: number; id: string; title: string; children: ReactNode }) {
  return (
    <section id={'epdoc-' + id} className="border-t-[1.5px] border-line-3 py-[22px]">
      <div className="flex items-baseline gap-2.5">
        <span className="tnum text-[13px] font-bold text-blue">{n}</span>
        <span className="text-[18px] font-extrabold tracking-[-0.01em] text-ink">{title}</span>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function DraftInput({ value, onChange, onEnter, placeholder }: { value: string; onChange: (v: string) => void; onEnter: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key !== 'Enter') return
        const v = value.trim()
        if (v) onEnter(v)
      }}
      placeholder={placeholder}
      className="h-[38px] rounded-[10px] border-[1.5px] border-dashed border-faint bg-white px-3 text-[13.5px] text-ink outline-0"
    />
  )
}
