import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { DvProject } from '../../api/devops/types'
import { useDv } from './ctx'
import { addD, dayOf, devDays, devList, devListFor, fieldOptions, fieldValue, fmtD, ownerColor, relD, teamOf, TODAY } from './model'
import { NewOptionForm } from './Sidebar'
import { Btn, Caret, Eyebrow, GlassMenu, Initial } from './ui'

const box = 'rounded-[14px] bg-canvas p-3.5'
const field = 'w-full rounded-[10px] border-0 bg-white px-2.5 py-[7px] text-[13px] text-ink outline-0'

/** Dev phase owner, the dev phase stepper and the DevOps phase timeline. */
export function PhasesTab({ p }: { p: DvProject }) {
  const { db, update, dd, setDd, setField, me } = useDv()
  const s = db.settings
  const rules = s.rules

  const [dn, setDn] = useState<{ title: string; owner: string | null; date: string } | null>(null)
  const [addingOwner, setAddingOwner] = useState(false)
  const [devEdit, setDevEdit] = useState<{ name: string; orig: string | null; id: number }[] | null>(null)
  const [devAdv, setDevAdv] = useState<{ note: string; due: string } | null>(null)
  const [devDateEdit, setDevDateEdit] = useState<string | null>(null)
  const [phaseDraft, setPhaseDraft] = useState<string | null>(null)
  const [promote, setPromote] = useState<{ draft: string; due: string; next: string } | null>(null)

  const dsteps = devListFor(p, s)
  const di = dsteps.indexOf(p.dev)
  const dues = p.devDues || {}
  const plan = p.devPlan || {}
  let prev: string | null = null
  const steps = dsteps.map((label, i) => {
    let iso = dayOf(dues[label] || (i === di ? p.devDue : null))
    if (!iso && plan[label]) iso = plan[label]
    const days = devDays(s, label)
    if (!iso && i > di && prev && days != null) iso = addD(prev, +days)
    if (iso) prev = iso
    const locked = i <= di && rules.lockDevDue && !!dues[label]
    const [rel, relC] = relD(iso, i === di)
    return { label, i, iso, locked, rel: i === di ? rel : '', relC, kind: i < di ? 'Done' : i === di ? 'Current' : 'Planned' }
  })
  const canDevAdvance = di < dsteps.length - 1
  const devNextTarget = dsteps[di + 1]
  const devNextLabel = di < 0 ? 'Start ' + dsteps[0] : 'Move to ' + dsteps[di + 1]

  const ownOpen = dd === 'devOwner'
  const ownerVal = fieldValue('devOwner', p, s, me)
  const hist = (p.history || []).slice().reverse()

  return (
    <>
      <div className="mb-7 flex items-center gap-3 rounded-2xl bg-canvas px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <Eyebrow>Dev phase owner</Eyebrow>
          <div className="mt-0.5 text-[12px]" style={{ color: p.devStepTitle ? '#1B2D45' : '#3B4A5E' }}>
            {p.devStepTitle ? 'Next: ' + p.devStepTitle + (p.devDue ? ' · due ' + fmtD(p.devDue) : '') : 'Development team contact for these phases'}
          </div>
        </div>
        {!p.devOwner ? (
          <button
            type="button"
            onClick={() => {
              const l = dsteps.filter(x => x !== 'Not started')
              const i = l.indexOf(p.dev)
              setDn({ title: l[i + 1] || l[0] || 'Next step', owner: null, date: '' })
            }}
            className="flex h-[34px] flex-none cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-blue px-4 text-[13px] font-semibold text-white hover:bg-blue-600"
          >
            Next step<span className="text-[14px] leading-none">→</span>
          </button>
        ) : (
          <div className="relative flex-none">
            <button
              type="button"
              onClick={() => setDd(ownOpen ? null : 'devOwner')}
              className="flex cursor-pointer items-center gap-2 rounded-lg border-0 bg-white py-[5px] pl-1.5 pr-2 text-[13px] font-semibold text-ink hover:![box-shadow:0_0_0_1.5px_rgba(0,0,0,0.15)]"
              style={{ boxShadow: ownOpen ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1px rgba(0,0,0,0.06)' }}
            >
              <Initial i={ownerVal !== 'Unassigned' ? ownerVal[0] : '–'} bg={ownerColor(ownerVal)} size={24} radius={6} font={11} />
              <span>{ownerVal}</span>
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-sky-2">
                <Caret />
              </span>
            </button>
            {ownOpen && (
              <GlassMenu
                title="Dev phase owner"
                onClose={() => setDd(null)}
                addLabel="New person"
                onAdd={() => {
                  setDd(null)
                  setAddingOwner(true)
                }}
                options={fieldOptions('devOwner', p, s, me).map(o => ({
                  label: o,
                  on: o === ownerVal,
                  avatar: { i: o !== 'Unassigned' ? o[0] : '–', bg: ownerColor(o) },
                  pick: () => {
                    setDd(null)
                    if (o !== ownerVal) setField(p, 'devOwner', o)
                  },
                }))}
              />
            )}
          </div>
        )}
      </div>

      {dn && !p.devOwner && (
        <div className="-mt-4 mb-7 rounded-2xl bg-canvas p-4">
          <div className="text-[14px] font-semibold">Set date and owner</div>
          <div className="mt-0.5 text-[12px] text-muted">Who on the development team owns the next step, and when it's due.</div>
          <div className="mt-3 text-[12px] text-muted">Title</div>
          <input
            value={dn.title}
            onChange={e => setDn({ ...dn, title: e.target.value })}
            placeholder="Next step"
            className="mt-1.5 w-full rounded-[10px] border-0 bg-white px-3 py-[9px] text-[14px] font-semibold text-ink outline-0 focus:shadow-[0_0_0_2px_#4870E8]"
          />
          <div className="mt-3 text-[12px] text-muted">Owner</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {teamOf(s, me).map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setDn({ ...dn, owner: n })}
                className="flex h-8 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-white pl-[5px] pr-3 text-[13px] font-medium text-ink"
                style={{ boxShadow: dn.owner === n ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1px #E4EAF0' }}
              >
                <Initial i={n[0]} bg={ownerColor(n)} />
                {n}
              </button>
            ))}
          </div>
          <label className="mt-3 block max-w-[220px]">
            <div className="mb-1 text-[12px] text-muted">Due date</div>
            <input type="date" value={dn.date} onChange={e => setDn({ ...dn, date: e.target.value })} className={field} />
          </label>
          <div className="mt-3.5 flex justify-end gap-2">
            <Btn kind="white" onClick={() => setDn(null)} className="px-3.5 py-1.5 text-[12px]">
              Cancel
            </Btn>
            <Btn
              onClick={() => {
                const t = dn.title.trim()
                if (!dn.owner || !dn.date || !t) return
                update(
                  p.key,
                  { devOwner: dn.owner, devDue: dn.date, devStepTitle: t },
                  { type: 'Action', text: t, detail: 'Owner ' + dn.owner + ' · due ' + fmtD(dn.date) },
                )
                setDn(null)
              }}
              className="px-3.5 py-1.5 text-[12px]"
              style={{ opacity: dn.owner && dn.date && dn.title.trim() ? 1 : 0.4 }}
            >
              Save
            </Btn>
          </div>
        </div>
      )}

      {addingOwner && (
        <div className="-mt-4 mb-7 rounded-[14px] bg-canvas px-3.5 py-3">
          <NewOptionForm k="devOwner" p={p} onDone={() => setAddingOwner(false)} />
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <Eyebrow>Dev phase</Eyebrow>
        {!devEdit && (
          <button
            type="button"
            onClick={() => setDevEdit(dsteps.map((name, i) => ({ name, orig: name, id: i })))}
            className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink"
          >
            Edit steps for this project
          </button>
        )}
      </div>
      {devEdit && (
        <div className={`${box} mb-4`}>
          <div className="flex flex-col gap-1.5">
            {devEdit.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2">
                <span className="tnum w-[18px] text-right text-[12px] text-slate">{i + 1}</span>
                <input placeholder="Name"
                  value={r.name}
                  onChange={e => setDevEdit(devEdit.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="min-w-0 flex-1 rounded-[9px] border-0 bg-white px-2.5 py-[7px] text-[13px] text-ink outline-0"
                />
                <button
                  type="button"
                  title="Move up"
                  onClick={() => {
                    if (!i) return
                    const d = devEdit.slice()
                    ;[d[i - 1], d[i]] = [d[i], d[i - 1]]
                    setDevEdit(d)
                  }}
                  className="w-[22px] cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-muted"
                  style={{ opacity: i ? 1 : 0.3 }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  onClick={() => {
                    if (i >= devEdit.length - 1) return
                    const d = devEdit.slice()
                    ;[d[i + 1], d[i]] = [d[i], d[i + 1]]
                    setDevEdit(d)
                  }}
                  className="w-[22px] cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-muted"
                  style={{ opacity: i < devEdit.length - 1 ? 1 : 0.3 }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => setDevEdit(devEdit.filter((_, j) => j !== i))}
                  className="w-[22px] cursor-pointer border-0 bg-transparent p-0 text-[15px] font-medium text-muted hover:text-rust"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDevEdit([...devEdit, { name: 'New step', orig: null, id: Date.now() }])}
            className="ml-[26px] mt-2.5 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink"
          >
            + Add step
          </button>
          <div className="mt-1.5 text-[12px] text-muted">Only changes this project. Default steps live in Settings → Dev phases.</div>
          {p.devSteps && (
            <button
              type="button"
              onClick={() => {
                const g = devList(s)
                update(
                  p.key,
                  { devSteps: null, ...(p.dev && !g.includes(p.dev) ? { dev: 'Not set' } : {}) },
                  { type: 'Field change', text: 'Dev phase steps reset to defaults', detail: g.join(' → ') },
                )
                setDevEdit(null)
              }}
              className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink"
            >
              Reset to default steps
            </button>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Btn kind="white" onClick={() => setDevEdit(null)} className="px-3 py-[5px] text-[12px]">
              Cancel
            </Btn>
            <Btn
              onClick={() => {
                const rows = devEdit.map(r => ({ ...r, name: r.name.trim() })).filter(r => r.name)
                const list = [...new Set(rows.map(r => r.name))]
                const ren: Record<string, string> = {}
                rows.forEach(r => {
                  if (r.orig) ren[r.orig] = r.name
                })
                const patch: Partial<DvProject> = { devSteps: list }
                if (p.dev && p.dev !== 'Not set') {
                  const nv = ren[p.dev] || (list.includes(p.dev) ? p.dev : 'Not set')
                  if (nv !== p.dev) patch.dev = nv
                }
                update(p.key, patch, { type: 'Field change', text: 'Dev phase steps updated for this project', detail: list.join(' → ') })
                setDevEdit(null)
              }}
              className="px-3.5 py-1.5 text-[12px]"
            >
              Save steps
            </Btn>
          </div>
        </div>
      )}
      <div className="flex gap-1.5">
        {steps.map(d => {
          const editing = devDateEdit === d.label
          return (
            <div key={d.label + d.i} className="min-w-0 flex-1">
              <div className="h-1 rounded-sm" style={{ background: d.i <= di ? '#9F89E5' : '#E4EAF0' }} />
              <div className="mt-2 text-[12px] leading-[1.3]" style={{ color: d.i <= di ? '#1B2D45' : '#3B4A5E', fontWeight: d.i === di ? 600 : 500 }}>
                {d.label}
              </div>
              {!editing ? (
                <div
                  onClick={() => !d.locked && setDevDateEdit(d.label)}
                  className="-ml-1.5 mt-1 rounded-lg px-1.5 py-1"
                  style={{ cursor: d.locked ? 'default' : 'pointer' }}
                  onMouseEnter={e => !d.locked && (e.currentTarget.style.background = '#F6F9FC')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <div
                    className="tnum whitespace-nowrap text-[13px] font-semibold"
                    style={{ color: d.iso ? (d.i === di && d.iso < TODAY ? '#A5502C' : d.i > di ? '#3B4A5E' : '#1B2D45') : '#1F3FAF' }}
                  >
                    {d.iso ? fmtD(d.iso) : 'Set date'}
                  </div>
                  <div className="mt-px text-[11px] font-medium" style={{ color: d.i === di ? '#9F89E5' : '#56657A' }}>
                    {d.kind} <span style={{ color: d.relC }}>{d.rel}</span> <span className="text-slate">{d.locked ? 'Fixed' : ''}</span>
                  </div>
                </div>
              ) : (
                <>
                  <input
                    type="date"
                    autoFocus
                    value={d.iso || ''}
                    onChange={e => {
                      const v = e.target.value
                      if (!v) return
                      const was = d.iso ? fmtD(d.iso) : '—'
                      const patch: Partial<DvProject> =
                        d.i <= di ? { devDues: { ...dues, [d.label]: v }, ...(d.i === di ? { devDue: v } : {}) } : { devPlan: { ...plan, [d.label]: v } }
                      update(p.key, patch, { type: 'Field change', text: d.label + ' date set to ' + fmtD(v), detail: 'Was: ' + was })
                      setDevDateEdit(null)
                    }}
                    className="mt-1.5 w-full rounded-lg border-0 bg-white px-1.5 py-[5px] text-[12px] text-ink outline-0 shadow-[0_0_0_2px_#9F89E5]"
                  />
                  <button type="button" onClick={() => setDevDateEdit(null)} className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-muted">
                    Cancel
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
      {canDevAdvance && !devAdv && (
        <Btn
          onClick={() => {
            const days = devNextTarget != null ? devDays(s, devNextTarget) : null
            setDevAdv({ note: '', due: days ? addD(TODAY, +days) : '' })
          }}
          className="mt-4 px-3.5 py-1.5 text-[12px]"
        >
          {devNextLabel}
        </Btn>
      )}
      {devAdv && (
        <div className={`${box} mt-4`}>
          <div className="text-[13px] font-semibold">{devNextLabel}</div>
          <textarea
            value={devAdv.note}
            onChange={e => setDevAdv({ ...devAdv, note: e.target.value })}
            rows={2}
            placeholder="What changed? e.g. Testing signed off by client"
            className="mt-2 w-full resize-y rounded-xl border-0 bg-white px-3 py-2.5 text-[13px] leading-normal text-ink outline-0"
          />
          <label className="mt-2.5 block max-w-[220px]">
            <div className="mb-1 text-[12px] text-muted">Dev phase due date · fixed once saved</div>
            <input
              type="date"
              value={devAdv.due}
              onChange={e => setDevAdv({ ...devAdv, due: e.target.value })}
              className={field}
              style={{ boxShadow: devAdv.due || !rules.requireDevDue ? 'none' : '0 0 0 1px #B98A2F' }}
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <Btn kind="white" onClick={() => setDevAdv(null)} className="px-3 py-[5px] text-[12px]">
              Cancel
            </Btn>
            <Btn
              onClick={() => {
                if ((rules.requireDevDue && !devAdv.due) || !devNextTarget) return
                const to = devNextTarget
                const due = devAdv.due || null
                const t = devAdv.note.trim()
                update(
                  p.key,
                  { dev: to, devDue: due, devDues: { ...dues, ...(due ? { [to]: due } : {}) } },
                  { type: 'Phase change', text: t || 'Dev phase moved to ' + to, detail: 'Dev phase: ' + (p.dev || 'Not set') + ' → ' + to + (due ? ' · due ' + fmtD(due) : '') },
                )
                setDevAdv(null)
              }}
              className="px-3.5 py-1.5 text-[12px]"
              style={{ opacity: devAdv.due || !rules.requireDevDue ? 1 : 0.4 }}
            >
              Save &amp; log
            </Btn>
          </div>
        </div>
      )}

      <div className="mb-6 mt-8 h-[0.5px] bg-black/[0.08]" />
      <Eyebrow className="mb-4">DevOps phase</Eyebrow>
      <div className="flex flex-col">
        {hist.map((ph, i) => (
          <div key={i} className="grid grid-cols-[18px_1fr] gap-3.5 opacity-55">
            <div className="flex flex-col items-center">
              <span className="mt-[5px] size-2.5 rounded-full bg-[#9F89E5]" />
              <span className="min-h-3.5 w-[1.5px] flex-1 bg-[#d9cffb]" />
            </div>
            <div className="min-w-0 pb-5">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[14px] font-medium">Previous phase</span>
                <span className="ml-auto text-[12px] text-muted">{(ph.due ? 'Due ' + fmtD(ph.due) + ' · ' : '') + ph.when}</span>
              </div>
              <div className="mt-1 text-[13px] leading-normal text-muted">{ph.text}</div>
            </div>
          </div>
        ))}
        <div className="grid grid-cols-[18px_1fr] gap-3.5">
          <div className="flex flex-col items-center">
            <span className="mt-[5px] size-2.5 rounded-full bg-[#9F89E5] shadow-[0_0_0_4px_rgba(125,92,240,0.16)]" />
            <span className="min-h-3.5 w-0 flex-1 border-l-[1.5px] border-dashed border-line" />
          </div>
          <div className="min-w-0 pb-7">
            <div className="flex items-baseline gap-2.5">
              <span className="text-[14px] font-semibold">Current phase</span>
              <span
                className="ml-auto text-[12px] font-medium"
                style={{ color: p.phaseDue ? (p.phaseDue < TODAY ? '#A5502C' : '#1B2D45') : '#56657A' }}
              >
                {p.phaseDue ? 'Due ' + fmtD(p.phaseDue) : 'No due date'}
              </span>
              {phaseDraft == null && (
                <button
                  type="button"
                  onClick={() => setPhaseDraft(p.phase || '')}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink"
                >
                  Edit
                </button>
              )}
            </div>
            {phaseDraft == null ? (
              <div className="mt-1.5 text-[17px] leading-normal tracking-[-0.015em] text-ink [text-wrap:pretty]">{p.phase || 'No phase noted'}</div>
            ) : (
              <>
                <textarea placeholder="What is happening now?"
                  autoFocus
                  value={phaseDraft}
                  onChange={e => setPhaseDraft(e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-y rounded-xl border-0 bg-canvas px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Btn kind="soft" onClick={() => setPhaseDraft(null)} className="px-3 py-[5px] text-[12px]">
                    Cancel
                  </Btn>
                  <Btn
                    onClick={() => {
                      const t = phaseDraft.trim()
                      if (t && t !== p.phase)
                        update(p.key, { phase: t, phaseWhen: 'Updated just now' }, { type: 'Phase change', text: 'Current phase updated', detail: 'Was: ' + (p.phase || '—') })
                      setPhaseDraft(null)
                    }}
                    className="px-3 py-[5px] text-[12px]"
                  >
                    Save
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-[18px_1fr] gap-3.5">
          <div className="flex justify-center">
            <span className="mt-[5px] size-2.5 rounded-full bg-white shadow-[inset_0_0_0_1.5px_#A9B6C5]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <span className="text-[14px] font-medium text-muted">Up next</span>
              <span className="ml-auto text-[12px] text-muted">{p.nextStart ? 'Starts ' + fmtD(p.nextStart) : ''}</span>
            </div>
            <div className="mt-1.5 text-[15px] leading-normal [text-wrap:pretty]" style={{ color: p.next ? '#22354C' : '#56657A' }}>
              {p.next || 'Not defined yet'}
            </div>
            {p.next && (
              <Btn kind="soft" onClick={() => setPromote({ draft: p.next || '', due: '', next: '' })} className="mt-3.5 px-3.5 py-1.5 text-[12px] hover:!bg-line-3">
                Make current phase
              </Btn>
            )}
          </div>
        </div>
      </div>

      {promote &&
        createPortal(
          <>
            <div onClick={() => setPromote(null)} className="fixed inset-0 z-40 bg-black/25" />
            <div className="fixed left-1/2 top-1/2 z-[41] w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[22px] bg-white p-7 font-normal text-ink shadow-[0_30px_90px_rgba(0,0,0,0.3)]">
              <div className="text-[20px] font-bold tracking-[-0.02em]">Does everything look right?</div>
              <div className="mt-1 text-[13px] text-muted">This becomes the current phase for {p.name} and is logged.</div>
              <textarea placeholder="What is happening now?"
                value={promote.draft}
                onChange={e => setPromote({ ...promote, draft: e.target.value })}
                rows={4}
                className="mt-5 w-full resize-y rounded-xl border-0 bg-canvas px-3 py-2.5 text-[15px] leading-normal text-ink outline-0"
              />
              <div className="mt-4 flex items-center gap-3">
                <div className="flex-1">
                  <div className="mb-1.5 text-[12px] text-muted">Phase due date · fixed once saved</div>
                  <input
                    type="date"
                    value={promote.due}
                    onChange={e => setPromote({ ...promote, due: e.target.value })}
                    className="w-full rounded-[10px] border-0 bg-canvas px-2.5 py-[7px] text-[13px] text-ink outline-0"
                    style={{ boxShadow: promote.due || !rules.requirePhaseDue ? 'none' : '0 0 0 1px #B98A2F' }}
                  />
                </div>
              </div>
              <div className="mt-4 text-[12px] text-muted">Up next (optional)</div>
              <textarea
                value={promote.next}
                onChange={e => setPromote({ ...promote, next: e.target.value })}
                rows={2}
                placeholder="What comes after this?"
                className="mt-1.5 w-full resize-y rounded-xl border-0 bg-canvas px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
              />
              <div className="mt-[22px] flex justify-end gap-2">
                <Btn kind="soft" onClick={() => setPromote(null)} className="px-3.5 py-[7px] text-[13px]">
                  Cancel
                </Btn>
                <Btn
                  onClick={() => {
                    const t = promote.draft.trim()
                    if (!t || (rules.requirePhaseDue && !promote.due)) return
                    update(
                      p.key,
                      {
                        phase: t,
                        phaseDue: promote.due || null,
                        next: promote.next.trim() || null,
                        nextStart: null,
                        phaseWhen: 'Started just now',
                        history: [...(p.history || []), { text: p.phase || '—', when: 'Ended just now', due: p.phaseDue }],
                      },
                      {
                        type: 'Phase change',
                        text: 'Next phase moved to current phase',
                        detail: (promote.due ? 'Phase due ' + fmtD(promote.due) + ' · ' : '') + 'was: ' + (p.phase || '—'),
                      },
                    )
                    setPromote(null)
                    setPhaseDraft(null)
                  }}
                  className="px-3.5 py-[7px] text-[13px]"
                  style={{ opacity: (promote.due || !rules.requirePhaseDue) && promote.draft.trim() ? 1 : 0.4 }}
                >
                  Save
                </Btn>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

