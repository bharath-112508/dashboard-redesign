import { useState } from 'react'
import { useSend } from '../../api/queries'
import { escalationIndex } from '../../api/devops/rules'
import type { DvRules, DvSettings } from '../../api/devops/types'
import { useDv } from './ctx'
import { T, tone } from './model'
import { Caret, GlassMenu, Switch } from './ui'

/** A row of a list in the draft. `id` is stable across renames, reorders and removals. */
type Row = { id: number; name: string; num: number | ''; desc: string; orig: string | null }
/** `escRow` is the id of the ladder row the project escalates from. */
type Draft = { ladder: Row[]; iladder: Row[]; dev: Row[]; infra: Row[]; rules: DvRules; escRow: number | null }
type ListKey = 'ladder' | 'iladder' | 'dev' | 'infra'

let rowSeq = 0
const rid = () => ++rowSeq

const TABS: [string, string][] = [
  ['infra', 'Statuses'],
  ['seq', 'Follow-up sequences'],
  ['dates', 'Date rules'],
  ['dev', 'Dev phases'],
]

const draftOf = (s: DvSettings): Draft => {
  const ladder = s.ladder.map((x, i) => ({ id: rid(), name: x.name, num: i ? x.hours : 0, desc: '', orig: x.name }))
  return {
    ladder,
    iladder: s.iladder.map(name => ({ id: rid(), name, num: '', desc: '', orig: name })),
    dev: s.devPhases.map(x => ({ id: rid(), name: x.name, num: x.days ?? '', desc: '', orig: x.name })),
    infra: s.statuses.map(x => ({ id: rid(), name: x.name, num: '', desc: x.desc, orig: x.name })),
    rules: { ...s.rules },
    escRow: ladder[escalationIndex(s)]?.id ?? null,
  }
}

const inp = 'rounded-[9px] border-0 bg-canvas px-2.5 py-2 text-[13px] text-ink outline-0'
const arrowBtn = 'w-[22px] cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-muted'

/** Settings: statuses, follow-up sequences, date rules and dev phases. Nothing is saved until "Save changes". */
export function SettingsModal({ tab }: { tab: string }) {
  const { db, open, dd, setDd } = useDv()
  const send = useSend()
  const [D, setD] = useState<Draft>(() => draftOf(db.settings))
  const close = () => open({ settings: null }, true)

  const rows = (key: ListKey) => {
    const list = D[key]
    const upd = (fn: (a: Row[]) => Row[]) => setD(d => ({ ...d, [key]: fn(d[key].slice()) }))
    return list.map((r, i) => ({
      r,
      i,
      border: i ? '1px solid #E7EEFB' : 'none',
      dot: tone(r.orig || r.name)[0],
      onName: (v: string) => upd(a => ((a[i] = { ...a[i], name: v }), a)),
      onNum: (v: string) => upd(a => ((a[i] = { ...a[i], num: v === '' ? '' : +v }), a)),
      onDesc: (v: string) => upd(a => ((a[i] = { ...a[i], desc: v }), a)),
      up: () => i && upd(a => ([a[i - 1], a[i]] = [a[i], a[i - 1]], a)),
      down: () => i < list.length - 1 && upd(a => ([a[i + 1], a[i]] = [a[i], a[i + 1]], a)),
      remove: () => upd(a => a.filter((_, j) => j !== i)),
      upOp: i ? 1 : 0.3,
      downOp: i < list.length - 1 ? 1 : 0.3,
    }))
  }
  const Arrows = ({ x, big = 16 }: { x: ReturnType<typeof rows>[number]; big?: number }) => (
    <div className="flex justify-end gap-0.5">
      <button type="button" onClick={x.up} className={arrowBtn} style={{ opacity: x.upOp }}>
        ↑
      </button>
      <button type="button" onClick={x.down} className={arrowBtn} style={{ opacity: x.downOp }}>
        ↓
      </button>
      <button type="button" onClick={x.remove} className={`${arrowBtn} hover:text-rust`} style={{ fontSize: big }}>
        ×
      </button>
    </div>
  )

  const save = () => {
    const lad = D.ladder.map(r => ({ ...r, name: r.name.trim() })).filter(r => r.name)
    if (!lad.length) return
    // The escalation step is the chosen row's (new) name. If that row was removed, the step at the same position takes over.
    const chosen = lad.find(r => r.id === D.escRow)
    const escName = (chosen ? chosen.name : lad[Math.min(escalationIndex(db.settings), lad.length - 1)].name) as string
    const ilad = D.iladder.map(r => r.name.trim()).filter(Boolean)
    const dev = D.dev.map(r => ({ ...r, name: r.name.trim() })).filter(r => r.name)
    const inf = D.infra.map(r => ({ ...r, name: r.name.trim() })).filter(r => r.name)
    const ren = (list: Row[]) => Object.fromEntries(list.filter(r => r.orig).map(r => [r.orig as string, r.name]))
    const uniq = <X extends { name: string }>(list: X[]) => list.filter((r, i) => list.findIndex(x => x.name === r.name) === i)
    const next: DvSettings = {
      ...db.settings,
      ladder: lad.map((r, i) => ({ name: r.name, hours: i ? (r.num === '' ? 24 : +r.num) : 0 })),
      iladder: ilad.length ? ilad : db.settings.iladder,
      devPhases: uniq(dev).map(r => ({ name: r.name, days: r.num === '' ? null : +r.num })),
      statuses: inf.length ? uniq(inf).map(r => ({ name: r.name, desc: r.desc.trim() })) : db.settings.statuses,
      rules: { ...D.rules, escStep: escName, esc: lad.findIndex(r => r.name === escName) },
    }
    send({ type: 'devops.settings.save', settings: next, renames: { statuses: inf.length ? ren(inf) : {}, ladder: ren(lad), dev: ren(dev) } })
    close()
  }

  const setRule = <K extends keyof DvRules>(k: K, v: DvRules[K]) => setD(d => ({ ...d, rules: { ...d.rules, [k]: v } }))
  const escIdx = D.ladder.findIndex(r => r.id === D.escRow)
  const toggles = (list: [keyof DvRules, string, string][]) =>
    list.map(([k, label, desc], i) => (
      <div key={k} className="flex items-center gap-4 px-4 py-3.5" style={{ borderTop: i ? '1px solid #E7EEFB' : 'none' }}>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{label}</div>
          <div className="mt-0.5 text-[12px] leading-[1.4] text-muted">{desc}</div>
        </div>
        <Switch big on={!!D.rules[k]} onClick={() => setRule(k, !D.rules[k] as never)} label={label} />
      </div>
    ))
  const head = (t: string, sub: string) => (
    <>
      <div className="text-[17px] font-semibold">{t}</div>
      <div className="mt-1 text-[13px] text-muted">{sub}</div>
    </>
  )
  const eyebrow = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-muted px-1'
  const cardC = 'rounded-[14px] bg-white shadow-[0_0_0_1px_#E4EAF0]'
  const addBtn = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className="ml-1.5 mt-3 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-blue-ink">
      {label}
    </button>
  )
  const escOpen = dd === 'esc'

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-50 animate-fade-in bg-[rgba(27,45,69,0.38)]" />
      <div
        role="dialog"
        data-testid="settings"
        className="fixed left-1/2 top-1/2 z-[51] flex h-[min(640px,calc(100vh-48px))] w-[820px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] bg-canvas font-normal text-ink shadow-[0_30px_90px_rgba(0,0,0,0.3)]"
      >
        <div className="flex-[0_0_210px] border-r border-line-3 bg-white/60 px-3 py-6">
          <div className="px-2.5 pb-4 text-[20px] font-bold tracking-[-0.02em]">Settings</div>
          <div className="flex flex-col gap-0.5">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => open({ settings: id }, true)}
                className="cursor-pointer rounded-lg border-0 px-2.5 py-2 text-left text-[13px] font-medium"
                style={{ background: tab === id ? '#4870E8' : 'transparent', color: tab === id ? '#fff' : '#1B2D45' }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-7 pb-5 pt-7">
            {tab === 'infra' && (
              <>
                {head('Statuses', 'Renaming updates every project. The description pre-fills the note you see when hovering a status in the list.')}
                <div className={`${cardC} mt-5 p-1.5`}>
                  {rows('infra').map(x => (
                    <div key={x.i} className="grid grid-cols-[24px_1fr_76px] gap-2.5 px-1 py-2" style={{ borderTop: x.border }}>
                      <span className="tnum pt-[9px] text-right text-[12px] text-slate">{x.i + 1}</span>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="size-2 flex-none rounded-full" style={{ background: x.dot }} />
                          <input placeholder="Name" value={x.r.name} onChange={e => x.onName(e.target.value)} className={`${inp} min-w-0 flex-1 font-medium`} />
                        </div>
                        <textarea
                          value={x.r.desc}
                          onChange={e => x.onDesc(e.target.value)}
                          rows={2}
                          placeholder="Default description for this status (optional)"
                          className={`${inp} ml-4 resize-y text-[12px] leading-[1.45]`}
                        />
                      </div>
                      <div className="pt-1.5">
                        <Arrows x={x} />
                      </div>
                    </div>
                  ))}
                </div>
                {addBtn('+ Add status', () => setD(d => ({ ...d, infra: [...d.infra, { id: rid(), name: 'New status', desc: '', num: '', orig: null }] })))}
                <div className="ml-1.5 mt-2 text-[12px] text-muted">Projects on a removed status move to the first status.</div>
              </>
            )}
            {tab === 'seq' && (
              <>
                {head('Follow-up sequences', 'Client follow-ups run on a fixed schedule. Internal follow-ups ask for the next date at each step.')}
                <div className={`${eyebrow} mt-6`}>Client</div>
                <div className="mt-0.5 px-1 pb-2.5 text-[12px] text-muted">
                  Starts when status moves to Client onboarding. Each step's wait (in hours after the previous step) pre-fills its date and time.
                </div>
                <div className="grid grid-cols-[24px_1fr_120px_76px] gap-2.5 px-1 pb-2 text-[12px] text-muted">
                  <span />
                  <span>Name</span>
                  <span>Hours after previous</span>
                  <span />
                </div>
                <div className={`${cardC} p-1.5`}>
                  {rows('ladder').map(x => (
                    <div key={x.i} className="grid grid-cols-[24px_1fr_120px_76px] items-center gap-2.5 px-1 py-[5px]" style={{ borderTop: x.border }}>
                      <span className="tnum text-right text-[12px] text-slate">{x.i + 1}</span>
                      <input placeholder="Name" value={x.r.name} onChange={e => x.onName(e.target.value)} className={`${inp} min-w-0`} />
                      <div className="flex items-center gap-1.5">
                        <input placeholder="e.g. 4" type="number" min={0} value={x.r.num} onChange={e => x.onNum(e.target.value)} className={`${inp} tnum w-16`} />
                        <span className="text-[12px] text-muted">h</span>
                      </div>
                      <Arrows x={x} />
                    </div>
                  ))}
                </div>
                {addBtn('+ Add step', () => setD(d => ({ ...d, ladder: [...d.ladder, { id: rid(), name: 'New step', num: 24, desc: '', orig: null }] })))}
                <div className={`${eyebrow} mt-7`}>Internal · dev team</div>
                <div className="mt-0.5 px-1 pb-2.5 text-[12px] text-muted">
                  Used when action is from the development team or DevOps. No fixed days; you set each date when moving to the step.
                </div>
                <div className={`${cardC} p-1.5`}>
                  {rows('iladder').map(x => (
                    <div key={x.i} className="grid grid-cols-[24px_1fr_76px] items-center gap-2.5 px-1 py-[5px]" style={{ borderTop: x.border }}>
                      <span className="tnum text-right text-[12px] text-slate">{x.i + 1}</span>
                      <input placeholder="Name" value={x.r.name} onChange={e => x.onName(e.target.value)} className={`${inp} min-w-0`} />
                      <Arrows x={x} />
                    </div>
                  ))}
                </div>
                {addBtn('+ Add step', () => setD(d => ({ ...d, iladder: [...d.iladder, { id: rid(), name: 'New step', num: '', desc: '', orig: null }] })))}
                <div className={`${eyebrow} mt-7 pb-2`}>Escalation</div>
                <div className={`${cardC} flex items-center gap-4 px-4 py-3.5`}>
                  <div className="flex-1">
                    <div className="text-[14px] font-medium">Mark as escalated from</div>
                    <div className="mt-0.5 text-[12px] text-muted">From this step on, the project shows in red.</div>
                  </div>
                  <div className="relative flex-none">
                    <button
                      type="button"
                      onClick={() => setDd(escOpen ? null : 'esc')}
                      className="flex cursor-pointer items-center gap-2 rounded-[9px] border-0 bg-canvas px-3 py-2 text-[13px] font-medium text-ink hover:bg-line-3"
                      style={{ boxShadow: escOpen ? '0 0 0 2px #4870E8' : 'none' }}
                    >
                      {escIdx >= 0 ? escIdx + 1 + '. ' + D.ladder[escIdx].name : '—'}
                      <span className="opacity-60">
                        <Caret sw={1.4} />
                      </span>
                    </button>
                    {escOpen && (
                      <GlassMenu
                        title="Escalate from"
                        z={52}
                        onClose={() => setDd(null)}
                        options={D.ladder.map((r, i) => {
                          const c = escIdx >= 0 && i >= escIdx ? T.red : T.blue
                          return {
                            label: i + 1 + '. ' + r.name,
                            on: r.id === D.escRow,
                            dot: [c[0], c[1]] as [string, string],
                            pick: () => {
                              setD(d => ({ ...d, escRow: r.id }))
                              setDd(null)
                            },
                          }
                        })}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
            {tab === 'dates' && (
              <>
                {head('Date rules', "What's required and what's locked when dates change.")}
                <div className={`${cardC} mt-5`}>
                  {toggles([
                    ['requireNote', 'Require "what happened" when moving a step', 'The note is also saved as the reason if the estimated deployment moves.'],
                    ['requireReminder', 'Require next reminder date', 'Every step move must set when to follow up next.'],
                    ['lockInitial', 'Lock initial due date', "Initial due date can't be edited once set."],
                    ['requirePhaseDue', 'Require due date for new DevOps phase', 'Asked when a next phase becomes current.'],
                  ])}
                </div>
                <div className={`${cardC} mt-3 flex items-center gap-4 px-4 py-3.5`}>
                  <div className="flex-1">
                    <div className="text-[14px] font-medium">Default reminder time</div>
                    <div className="mt-0.5 text-[12px] text-muted">Added to every new reminder date.</div>
                  </div>
                  <input type="time" value={D.rules.remTime} onChange={e => setRule('remTime', e.target.value)} className={`${inp} tnum`} />
                </div>
              </>
            )}
            {tab === 'dev' && (
              <>
                {head('Dev phases', 'Renaming updates every project. Typical duration pre-fills the due date when a project moves into that phase.')}
                <div className="mt-5">
                  <div className="grid grid-cols-[24px_1fr_120px_76px] gap-2.5 px-1 pb-2 text-[12px] text-muted">
                    <span />
                    <span>Name</span>
                    <span>Typical duration</span>
                    <span />
                  </div>
                  <div className={`${cardC} p-1.5`}>
                    {rows('dev').map(x => (
                      <div key={x.i} className="grid grid-cols-[24px_1fr_120px_76px] items-center gap-2.5 px-1 py-[5px]" style={{ borderTop: x.border }}>
                        <span className="tnum text-right text-[12px] text-slate">{x.i + 1}</span>
                        <input placeholder="Name" value={x.r.name} onChange={e => x.onName(e.target.value)} className={`${inp} min-w-0`} />
                        <div className="flex items-center gap-1.5">
                          <input placeholder="e.g. 4" type="number" min={0} value={x.r.num} onChange={e => x.onNum(e.target.value)} className={`${inp} tnum w-16`} />
                          <span className="text-[12px] text-muted">days</span>
                        </div>
                        <Arrows x={x} />
                      </div>
                    ))}
                  </div>
                </div>
                {addBtn('+ Add phase', () => setD(d => ({ ...d, dev: [...d.dev, { id: rid(), name: 'New phase', num: '', desc: '', orig: null }] })))}
                <div className={`${eyebrow} mt-7 pb-2`}>Rules</div>
                <div className={cardC}>
                  {toggles([
                    ['requireDevDue', 'Require due date when moving dev phase', 'Pre-filled from the typical duration.'],
                    ['lockDevDue', 'Lock dev phase due date', 'Due date is fixed once the phase starts.'],
                  ])}
                </div>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-line-3 bg-white/60 px-7 py-3.5">
            <button type="button" onClick={close} className="cursor-pointer rounded-lg border-0 bg-white px-4 py-2 text-[13px] font-medium text-ink shadow-[0_0_0_1px_#E4EAF0]">
              Cancel
            </button>
            <button type="button" onClick={save} className="cursor-pointer rounded-lg border-0 bg-blue px-[18px] py-2 text-[13px] font-medium text-white">
              Save changes
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
