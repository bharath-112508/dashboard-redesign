import { useState } from 'react'
import type { DvProject } from '../../api/devops/types'
import { useDv } from './ctx'
import {
  addH,
  dayOf,
  diffD,
  escIndex,
  fmtD,
  fmtDay,
  infraText,
  lad,
  ladderOffsets,
  movedLabel,
  offs,
  seq,
  TODAY,
  tone,
} from './model'
import { Btn, Caret, Eyebrow, GlassMenu, LinkBtn } from './ui'

const box = 'rounded-[14px] bg-canvas p-3.5'
const field = 'w-full rounded-[10px] border-0 bg-white px-2.5 py-[7px] text-[13px] text-ink outline-0'
const area = 'w-full resize-y rounded-xl border-0 px-3 py-2.5 text-[13px] leading-normal text-ink outline-0'

const toMap = (arr: string[]) => Object.fromEntries(arr.map((v, i) => [i, v])) as Record<number, string>

/** Status card, the client / internal follow-up sequences and the project's notes. */
export function FollowUpsTab({ p }: { p: DvProject }) {
  const { db, update, dd, setDd, setField, setChg, me, seqTab, setSeqTab } = useDv()
  const s = db.settings
  const L = lad(p, s)
  const O = offs(p, s)
  const dates = seq(p, s)
  const rt = s.rules.remTime
  const isCl = p.from === 'Client'
  const onLadder = isCl && p.step != null && p.infra !== 'Not started'
  const isInternal = !isCl && !!p.from && p.from !== 'Not set'
  const fromLower = (p.from || '').toLowerCase()

  const stv = seqTab || (isInternal ? 'int' : 'cl')
  const showCl = stv === 'cl' && onLadder
  const showInt = stv === 'int' && isInternal

  // Client sequence state
  const [editNote, setEditNote] = useState<number | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [adv, setAdv] = useState<{ draft: string; rem: string; due: string } | null>(null)
  const [seqSnap, setSeqSnap] = useState<string | null>(null)
  const [addStep, setAddStep] = useState<{ name: string; hours: number | '' } | null>(null)
  // Internal sequence state
  const [ifu, setIfu] = useState<{ note: string; date: string } | null>(null)
  // Notes
  const [pnDraft, setPnDraft] = useState('')
  const [pnEdit, setPnEdit] = useState<{ id: number; text: string } | null>(null)

  const st = tone(p.infra)
  const note = infraText(p, s)
  const scOpen = dd === 'sc'
  const hotC = p.step != null && p.step >= escIndex(s) ? '#D2724A' : '#4870E8'
  const setDates = (d: string[]) => update(p.key, { dates: toMap(d) })
  const step = p.step ?? 0
  const canAdvance = p.step != null && p.step < L.length - 1
  const nextStepLabel = canAdvance ? 'Move to ' + L[step + 1] : ''

  const advanceStep = () => {
    if (!adv) return
    const t = adv.draft.trim()
    if (!canAdvance || (s.rules.requireNote && !t) || (s.rules.requireReminder && !adv.rem)) return
    const n = step + 1
    const d = dates.slice()
    if (adv.rem) d[n] = adv.rem.slice(0, 16)
    const patch: Partial<DvProject> = {
      step: n,
      act: L[n],
      reminder: adv.rem ? adv.rem.slice(0, 16) : p.reminder,
      overdue: adv.rem ? adv.rem < TODAY : !!p.overdue,
      notes: { ...(p.notes || {}), [n]: { text: t || 'Moved to ' + L[n], when: 'Just now' } },
      dates: toMap(d),
    }
    let det = 'Moved from ' + L[step] + ' to ' + L[n] + (adv.rem ? ' · next reminder ' + fmtD(adv.rem) : '')
    if (t) det = 'What happened: ' + t + ' · ' + det
    const due = adv.due
    if (due && due !== dayOf(p.latestDue || p.initDue)) {
      patch.latestDue = due
      if (p.initDue) patch.moved = movedLabel(due, p.initDue)
      if (t) patch.reason = t
      det += ' · estimated deployment ' + fmtD(due)
    }
    update(p.key, patch, { type: 'Action', text: 'Moved to ' + L[n], detail: det })
    setAdv(null)
  }

  const advDelta = (() => {
    const ini = dayOf(p.initDue)
    if (!ini || !adv?.due) return { t: p.initDue ? '' : 'No initial due date set', c: '#3B4A5E' }
    const d = diffD(adv.due, ini)
    return {
      t: d === 0 ? 'On the initial due date (' + fmtDay(p.initDue) + ')' : Math.abs(d) + ' days ' + (d > 0 ? 'after' : 'before') + ' the initial due date (' + fmtDay(p.initDue) + ')',
      c: d > 0 ? '#7A5C0E' : '#3B4A5E',
    }
  })()

  const ifuList = p.ifu || []
  const ic = ifuList.length - 1
  const ifuEmpty = !ifuList.length
  const ifuNextName = s.iladder[ifuList.length] || ''
  const saveIfu = () => {
    if (!ifu?.date) return
    const t = ifu.note.trim()
    const arr = ifuList.slice()
    const first = !arr.length
    if (arr.length >= s.iladder.length) return
    if (!first) {
      if (!t) return
      arr[arr.length - 1] = { ...arr[arr.length - 1], done: true, note: t }
    }
    arr.push({ date: ifu.date, name: s.iladder[arr.length] })
    update(
      p.key,
      { ifu: arr, reminder: ifu.date + 'T' + rt, overdue: ifu.date < TODAY },
      {
        type: first ? 'Action' : 'Follow-up',
        text: first ? 'Internal follow-up set for ' + fmtD(ifu.date) : t,
        detail: first ? 'Waiting on ' + fromLower : 'Moved to ' + s.iladder[arr.length - 1] + ' · ' + fmtD(ifu.date),
      },
    )
    setIfu(null)
  }

  const pn = p.pnotes || []
  const tabs: ['cl' | 'int', string, boolean][] = [
    ['cl', 'Client', onLadder],
    ['int', 'Internal', isInternal],
  ]
  const OFFS = ladderOffsets(s)

  return (
    <>
      {/* Status card */}
      <div className="mb-8 rounded-lg bg-canvas px-[18px] pb-[18px] pt-4 shadow-[inset_0_0_0_1px_#DDE3E8]">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <Eyebrow>Status</Eyebrow>
            <div className="relative mt-2.5">
              <button
                type="button"
                data-testid="status-change"
                onClick={() => setDd(scOpen ? null : 'sc')}
                className="inline-flex max-w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-white py-2 pl-3 pr-2 text-left text-[18px] font-semibold leading-[1.25] tracking-[-0.01em] text-ink transition-shadow duration-150 hover:![box-shadow:inset_0_0_0_1px_#A9B6C5]"
                style={{ boxShadow: scOpen ? 'inset 0 0 0 2px #4870E8' : 'inset 0 0 0 1px #DDE3E8' }}
              >
                <span className="size-2 flex-none rounded-[2px]" style={{ background: st[0] }} />
                <span className="min-w-0 truncate whitespace-nowrap">{p.infra || 'Not set'}</span>
                <span className="ml-1.5 flex flex-none items-center gap-1.5 rounded bg-sky-2 py-1 pl-2.5 pr-2 text-[12px] font-semibold tracking-normal text-ink-2">
                  Change
                  <Caret size={10} sw={1.4} />
                </span>
              </button>
              {scOpen && (
                <GlassMenu
                  title="Move to"
                  align="left"
                  width={270}
                  gap={8}
                  onClose={() => setDd(null)}
                  options={s.statuses.map(({ name }) => {
                    const on = name === p.infra
                    const t = tone(name)
                    return {
                      label: name,
                      on,
                      dot: [t[0], t[1]],
                      pick: () => {
                        setDd(null)
                        if (!on) setField(p, 'infra', name)
                      },
                    }
                  })}
                />
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setDd(null)
              setChg({ key: p.key, to: p.infra, note, due: p.initDue || '', start: '' })
            }}
            className="flex-none cursor-pointer rounded border-0 bg-white px-3.5 py-1.5 text-[12px] font-semibold text-ink-2 shadow-[inset_0_0_0_1px_#DDE3E8] hover:bg-sky-2"
          >
            Edit status description
          </button>
        </div>
        <div
          className="mt-3 whitespace-pre-wrap rounded-md bg-white px-3.5 py-3 text-[14px] leading-[1.55] shadow-[inset_0_0_0_1px_#E4EAF0] [text-wrap:pretty]"
          style={{ color: note ? '#1B2D45' : '#56657A' }}
        >
          {note || 'No description yet. Use Edit description to add one.'}
        </div>
      </div>

      {/* Client / Internal switch */}
      <div className="mb-5 flex w-max max-w-full gap-0.5 rounded-[10px] bg-[rgba(118,118,128,0.12)] p-[3px]">
        {tabs.map(([id, label, use]) => {
          const on = stv === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSeqTab(id)}
              className="flex cursor-pointer items-center gap-2 rounded-[7px] border-0 px-4 py-1.5 text-[13px] font-semibold"
              style={{ color: on ? '#1B2D45' : '#3B4A5E', background: on ? '#fff' : 'transparent', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.12)' : 'none' }}
            >
              {label}
              <span className="rounded px-1.5 py-px text-[11px] font-semibold text-[#1d7d3a]" style={{ background: '#e7f6eb', opacity: use ? 1 : 0 }}>
                In use
              </span>
            </button>
          )
        })}
      </div>

      {!showCl && !showInt && (
        <>
          <div className="rounded-[14px] bg-canvas px-4 py-3.5 text-[13px] leading-normal text-muted">
            {stv === 'cl'
              ? isInternal
                ? 'Not in use. This project is waiting on ' + fromLower + ', so the internal sequence is running.'
                : 'Not running yet. The client sequence starts when status moves to Client onboarding; you pick the start date then.'
              : 'Not in use. The internal sequence runs when the action is from the development team or DevOps.'}
          </div>
          <div className="mt-[18px] flex flex-col gap-3 opacity-50">
            {(stv === 'cl'
              ? s.ladder.map((x, i) => ({ name: x.name, hint: i ? '+' + (OFFS[i] - OFFS[i - 1]) + ' h' : 'Start' }))
              : s.iladder.map(name => ({ name, hint: 'Date set at step' }))
            ).map(x => (
              <div key={x.name} className="flex items-center gap-3.5">
                <span className="ml-1 size-2.5 flex-none rounded-full shadow-[inset_0_0_0_1.5px_#A9B6C5]" />
                <span className="text-[14px] text-muted">{x.name}</span>
                <span className="ml-auto text-[12px] text-slate">{x.hint}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {showInt && (
        <>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <Eyebrow>Internal follow-up</Eyebrow>
            <span className="text-[12px] text-muted">Waiting on {fromLower}</span>
          </div>
          <div className="mb-[18px] text-[12px] text-muted">Internal sequence. Set the date for each step when you move to it.</div>
          <div className="flex flex-col">
            {s.iladder.map((name, i) => {
              const x = ifuList[i]
              const cur = i === ic
              const done = i < ic
              const late = cur && !!x && x.date < TODAY
              const last = i === s.iladder.length - 1
              return (
                <div key={name + i} className="grid grid-cols-[18px_1fr] gap-3.5" style={{ opacity: i > ic ? 0.5 : 1 }}>
                  <div className="flex flex-col items-center">
                    <span
                      className="mt-[5px] size-2.5 rounded-full"
                      style={{ background: i <= ic ? '#4870E8' : '#fff', boxShadow: i <= ic ? 'none' : 'inset 0 0 0 1.5px #A9B6C5' }}
                    />
                    <span className="min-h-3.5 w-[1.5px] flex-1" style={{ background: last ? 'transparent' : i < ic ? '#4870E8' : '#E4EAF0' }} />
                  </div>
                  <div className="min-w-0" style={{ paddingBottom: last ? 0 : cur ? 26 : 18 }}>
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[14px]" style={{ fontWeight: cur ? 600 : 500, color: i <= ic ? '#1B2D45' : '#3B4A5E' }}>
                        {name}
                      </span>
                      <span
                        className="tnum ml-auto whitespace-nowrap text-[12px]"
                        style={{ color: late ? '#A5502C' : x ? (done ? '#3B4A5E' : '#1B2D45') : '#56657A' }}
                      >
                        {x ? (done ? 'Done ' : late ? 'Overdue · ' : 'Due ') + fmtD(x.date) : 'Date set when you get here'}
                      </span>
                    </div>
                    {x?.note && <div className="mt-1 text-[13px] leading-normal text-ink-2 [text-wrap:pretty]">{x.note}</div>}
                  </div>
                </div>
              )
            })}
          </div>
          {!ifu && ifuList.length < s.iladder.length && (
            <Btn onClick={() => setIfu({ note: '', date: '' })} className="mt-4 px-3.5 py-1.5 text-[12px]">
              {ifuEmpty ? 'Start · set first date' : 'Move to ' + ifuNextName}
            </Btn>
          )}
          {ifu && (
            <div className={`${box} mt-4`}>
              <div className="text-[13px] font-semibold">{ifuEmpty ? 'Start internal follow-up' : 'What did they say?'}</div>
              {!ifuEmpty && (
                <textarea
                  value={ifu.note}
                  onChange={e => setIfu({ ...ifu, note: e.target.value })}
                  rows={2}
                  placeholder="e.g. Dev team needs two more days for the API changes"
                  className={`${area} mt-2 bg-white`}
                />
              )}
              <label className="mt-2.5 block max-w-[240px]">
                <div className="mb-1 text-[12px] text-muted">{ifuEmpty ? 'When will you first follow up?' : 'When is ' + (ifuNextName || 'the next step') + '?'}</div>
                <input type="date" value={ifu.date} onChange={e => setIfu({ ...ifu, date: e.target.value })} className={field} />
              </label>
              <div className="mt-3 flex justify-end gap-2">
                <Btn kind="white" onClick={() => setIfu(null)} className="px-3 py-[5px] text-[12px]">
                  Cancel
                </Btn>
                <Btn
                  onClick={saveIfu}
                  className="px-3 py-[5px] text-[12px]"
                  style={{ opacity: ifu.date && (ifuEmpty || ifu.note.trim()) ? 1 : 0.4 }}
                >
                  Save
                </Btn>
              </div>
            </div>
          )}
        </>
      )}

      {showCl && (
        <>
          <div className="mb-[18px] flex items-center justify-between">
            <Eyebrow>Sequence</Eyebrow>
            <button
              type="button"
              onClick={() => {
                if (seqSnap == null) return setSeqSnap(dates.join('|'))
                if (seqSnap !== dates.join('|'))
                  update(p.key, {}, { type: 'Action', text: 'Follow-up schedule updated', detail: L.map((l, i) => l + ': ' + fmtD(dates[i])).join(' · ') })
                setSeqSnap(null)
              }}
              className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink"
            >
              {seqSnap != null ? 'Done' : 'Edit dates'}
            </button>
          </div>
          <div className="flex flex-col">
            {L.map((label, i) => {
              const done = i <= step
              const past = i < step
              const cur = i === step
              const n = p.notes?.[i]
              const editing = editNote === i
              const iso = dates[i]
              const late = cur && iso < TODAY + 'T09:00'
              const verb = past ? 'Done' : cur ? 'Due' : 'Planned'
              const last = i === L.length - 1
              return (
                <div key={label + i} className="grid grid-cols-[18px_1fr] gap-3.5" style={{ opacity: i > step ? 0.5 : 1 }}>
                  <div className="flex flex-col items-center">
                    <span
                      className="mt-[5px] size-2.5 rounded-full"
                      style={{ background: done ? hotC : '#fff', boxShadow: done ? 'none' : 'inset 0 0 0 1.5px #A9B6C5' }}
                    />
                    <span className="min-h-3.5 w-[1.5px] flex-1" style={{ background: last ? 'transparent' : i < step ? hotC : '#E4EAF0' }} />
                  </div>
                  <div className="min-w-0" style={{ paddingBottom: last ? 0 : cur ? 26 : 18 }}>
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[14px]" style={{ color: done ? '#1B2D45' : '#3B4A5E', fontWeight: cur ? 600 : 500 }}>
                        {label}
                      </span>
                      <span
                        className="tnum ml-auto whitespace-nowrap text-[12px]"
                        style={{ color: late ? '#A5502C' : past ? '#3B4A5E' : cur ? '#1B2D45' : '#3B4A5E' }}
                      >
                        {verb} {fmtD(iso)}
                      </span>
                      {i >= s.ladder.length && i > step && (
                        <button
                          type="button"
                          title="Remove step"
                          onClick={() => {
                            const xs = (p.xsteps || []).filter((_, j) => j !== i - s.ladder.length)
                            const d = dates.slice()
                            d.splice(i, 1)
                            update(p.key, { xsteps: xs, dates: toMap(d) }, { type: 'Action', text: 'Follow-up step removed: ' + label })
                          }}
                          className="cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-slate hover:text-rust"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {seqSnap != null && (
                      <div className="mt-1.5 flex items-center gap-2.5">
                        <input
                          type="datetime-local"
                          value={iso}
                          onChange={e => {
                            const v = e.target.value
                            if (!v) return
                            const d = dates.slice()
                            d[i] = v
                            setDates(d)
                          }}
                          className="rounded-lg border-0 bg-canvas px-2 py-1 text-[12px] text-ink outline-0"
                        />
                        {i < L.length - 1 && (
                          <LinkBtn
                            onClick={() => {
                              const d = dates.slice()
                              for (let j = i + 1; j < d.length; j++) d[j] = addH(d[i], O[j] - O[i], rt)
                              setDates(d)
                            }}
                          >
                            Shift later steps
                          </LinkBtn>
                        )}
                      </div>
                    )}
                    {done && !editing && (
                      <div className="mt-1 flex items-start gap-3">
                        <div className="flex-1 text-[13px] leading-normal [text-wrap:pretty]" style={{ color: n ? '#22354C' : '#56657A' }}>
                          {n ? n.text : 'No note yet'}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setEditNote(i)
                            setNoteDraft(n ? n.text : '')
                          }}
                          className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted hover:text-blue-ink"
                        >
                          {n ? 'Edit' : 'Add note'}
                        </button>
                      </div>
                    )}
                    {editing && (
                      <>
                        <textarea
                          autoFocus
                          value={noteDraft}
                          onChange={e => setNoteDraft(e.target.value)}
                          rows={2}
                          placeholder="What happened at this step?"
                          className={`${area} mt-2 bg-canvas`}
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <Btn kind="soft" onClick={() => setEditNote(null)} className="px-3 py-[5px] text-[12px]">
                            Cancel
                          </Btn>
                          <Btn
                            onClick={() => {
                              const t = noteDraft.trim()
                              if (!t) return
                              const old = n?.text
                              update(
                                p.key,
                                { notes: { ...(p.notes || {}), [i]: { text: t, when: 'Just now' } } },
                                { type: 'Action', text: t, detail: (old ? 'Edited note on ' : 'Added note to ') + L[i] },
                              )
                              setEditNote(null)
                            }}
                            className="px-3 py-[5px] text-[12px]"
                          >
                            Save
                          </Btn>
                        </div>
                      </>
                    )}
                    {cur && canAdvance && !adv && (
                      <Btn
                        onClick={() =>
                          setAdv({ draft: '', rem: dates[Math.min(step + 1, L.length - 1)], due: dayOf(p.latestDue || p.initDue) || '' })
                        }
                        className="mt-3 px-3.5 py-1.5 text-[12px]"
                      >
                        {nextStepLabel}
                      </Btn>
                    )}
                    {cur && adv && (
                      <div className={`${box} mt-3`}>
                        <div className="text-[13px] font-semibold">What happened?</div>
                        <div className="mt-0.5 text-[12px] text-muted">Also saved as the reason if the estimated deployment moves.</div>
                        <textarea
                          autoFocus
                          value={adv.draft}
                          onChange={e => setAdv({ ...adv, draft: e.target.value })}
                          rows={2}
                          placeholder="e.g. Sent second reminder, no reply from client"
                          className={`${area} mt-2 bg-white`}
                        />
                        <div className="mt-3 grid grid-cols-2 gap-2.5">
                          <label className="block">
                            <div className="mb-1 text-[12px] text-muted">Next reminder</div>
                            <input type="datetime-local" value={adv.rem} onChange={e => setAdv({ ...adv, rem: e.target.value })} className={field} />
                          </label>
                          <label className="block">
                            <div className="mb-1 text-[12px] text-muted">Estimated deployment</div>
                            <input type="date" value={adv.due} onChange={e => setAdv({ ...adv, due: e.target.value })} className={field} />
                          </label>
                        </div>
                        <div className="mt-1.5 text-[12px]" style={{ color: advDelta.c }}>
                          {advDelta.t}
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                          <Btn kind="white" onClick={() => setAdv(null)} className="px-3 py-[5px] text-[12px]">
                            Cancel
                          </Btn>
                          <Btn onClick={advanceStep} className="px-3 py-[5px] text-[12px]">
                            {nextStepLabel}
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {!addStep && (
            <button
              type="button"
              onClick={() => setAddStep({ name: '', hours: 24 })}
              className="ml-8 mt-4 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-blue-ink"
            >
              + Add step
            </button>
          )}
          {addStep && (
            <div className={`${box} ml-8 mt-4`}>
              <div className="text-[13px] font-semibold">Add a step for this project</div>
              <div className="mt-0.5 text-[12px] text-muted">Added after {L[L.length - 1]}. The default sequence in Settings stays the same.</div>
              <div className="mt-2.5 grid grid-cols-[1fr_130px] gap-2.5">
                <label className="block">
                  <div className="mb-1 text-[12px] text-muted">Step name</div>
                  <input
                    autoFocus
                    value={addStep.name}
                    onChange={e => setAddStep({ ...addStep, name: e.target.value })}
                    placeholder="e.g. Call client's manager"
                    className={field}
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-[12px] text-muted">Hours after previous</div>
                  <input
                    type="number"
                    min={0}
                    value={addStep.hours}
                    onChange={e => setAddStep({ ...addStep, hours: e.target.value === '' ? '' : +e.target.value })}
                    className={field}
                  />
                </label>
              </div>
              <div className="mt-1.5 text-[12px] text-muted">Planned for {fmtD(addH(dates[dates.length - 1], +addStep.hours || 0, rt))}</div>
              <div className="mt-3 flex justify-end gap-2">
                <Btn kind="white" onClick={() => setAddStep(null)} className="px-3 py-[5px] text-[12px]">
                  Cancel
                </Btn>
                <Btn
                  onClick={() => {
                    const t = addStep.name.trim()
                    if (!t) return
                    const h = +addStep.hours || 0
                    const iso = addH(dates[dates.length - 1], h, rt)
                    update(
                      p.key,
                      { xsteps: [...(p.xsteps || []), { name: t, off: O[O.length - 1] + h }], dates: toMap([...dates, iso]) },
                      { type: 'Action', text: 'Follow-up step added: ' + t, detail: 'Planned ' + fmtD(iso) + ' · ' + h + ' h after ' + L[L.length - 1] },
                    )
                    setAddStep(null)
                  }}
                  className="px-3 py-[5px] text-[12px]"
                  style={{ opacity: addStep.name.trim() ? 1 : 0.4 }}
                >
                  Add step
                </Btn>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mb-6 mt-8 h-[0.5px] bg-black/[0.08]" />
      <div className="mb-3.5 flex items-baseline justify-between">
        <Eyebrow>Notes</Eyebrow>
        <span className="text-[12px] text-slate">{pn.length ? pn.length + (pn.length > 1 ? ' notes' : ' note') : ''}</span>
      </div>
      <div className="rounded-[14px] bg-canvas p-1">
        <textarea
          value={pnDraft}
          onChange={e => setPnDraft(e.target.value)}
          rows={2}
          placeholder="Add a note for this project…"
          className="w-full resize-y rounded-xl border-0 bg-transparent px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
        />
        <div className="flex justify-end px-1.5 pb-1.5">
          <Btn
            onClick={() => {
              const t = pnDraft.trim()
              if (!t) return
              update(p.key, { pnotes: [{ id: Date.now(), text: t, by: me, when: 'Just now' }, ...pn] }, { type: 'Note', text: 'Added note to ' + p.name, detail: t })
              setPnDraft('')
            }}
            className="px-3.5 py-1.5 text-[12px]"
            style={{ opacity: pnDraft.trim() ? 1 : 0.4 }}
          >
            Add note
          </Btn>
        </div>
      </div>
      <div className="mt-3.5 flex flex-col gap-2">
        {pn.map(n => (
          <div key={n.id} className="rounded-xl bg-white px-3.5 py-3 shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)]">
            {pnEdit?.id !== n.id ? (
              <>
                <div className="whitespace-pre-wrap text-[14px] leading-normal [text-wrap:pretty]">{n.text}</div>
                <div className="mt-2 flex items-center gap-3 text-[12px] text-slate">
                  <span>
                    {n.by} · {n.when}
                  </span>
                  <div className="flex-1" />
                  <button type="button" onClick={() => setPnEdit({ id: n.id, text: n.text })} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted hover:text-blue-ink">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => update(p.key, { pnotes: pn.filter(x => x.id !== n.id) }, { type: 'Note', text: 'Note deleted', detail: n.text })}
                    className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted hover:text-rust"
                  >
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  autoFocus
                  value={pnEdit.text}
                  onChange={e => setPnEdit({ ...pnEdit, text: e.target.value })}
                  rows={3}
                  className="w-full resize-y rounded-[10px] border-0 bg-canvas px-2.5 py-2 text-[14px] leading-normal text-ink outline-0 shadow-[0_0_0_2px_#4870E8]"
                />
                <div className="mt-2 flex justify-end gap-3">
                  <LinkBtn onClick={() => setPnEdit(null)}>Cancel</LinkBtn>
                  <LinkBtn
                    strong
                    onClick={() => {
                      const t = pnEdit.text.trim()
                      if (!t) return
                      update(
                        p.key,
                        { pnotes: pn.map(x => (x.id === n.id ? { ...x, text: t, when: 'Edited just now' } : x)) },
                        n.text !== t ? { type: 'Note', text: 'Edited note on ' + p.name, detail: 'Was: ' + n.text } : undefined,
                      )
                      setPnEdit(null)
                    }}
                  >
                    Save
                  </LinkBtn>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
